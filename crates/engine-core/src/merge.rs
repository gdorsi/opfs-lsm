//! Compaction as a session the host drives a stop at a time, so that the
//! engine holds a window of each input instead of the whole input.
//!
//! The host opens a session with the sizes of the input runs and pumps it.
//! Each pump stops between two keys and asks the host for one thing: read
//! some bytes (`Need`), take output bytes (`Write`), close the output run
//! (`RunEnd`), give the event loop a turn (`Yield`), or install the result
//! (`Done`). The session owns every offset and only asks for whole blocks.
//!
//! The inputs are sources, newest first. A source is one or more runs read
//! back to back as one key-ordered stream: an L0 run, or the runs of a lower
//! level that the step overlaps. For a key, the newest source wins and, within
//! a source, the last duplicate wins, across block, read and run boundaries.
//!
//! What it holds, whatever the inputs' size: per source about `chunk_bytes` of
//! framed blocks (more only for a block, or a run's bloom and index, that is
//! larger), one unpacked block and two entries; for the output, one open block, a bloom
//! hash and an index row per key and block of the open run, and up to
//! `chunk_bytes` plus one block of bytes not yet written.

use crate::crc32::{crc32, crc32_combine, Crc32};
use crate::sst::{
    entry_size, lz4_size_fits, read_footer, read_u32, BlockWalk, Codec, Entry, EntryRef, Layout, OutOfOrder, Record,
    RunEnd, SstError, SstWriter, BLOCK_TARGET, FOOTER_BYTES,
};
use alloc::collections::TryReserveError;
use alloc::vec::Vec;
use core::cmp::Ordering;
use core::mem;

#[cfg(test)]
mod oracle;
#[cfg(test)]
mod tests;

/// How a session reads, cuts and paces.
#[derive(Debug, Clone, Copy)]
pub struct MergeConfig {
    /// Drop tombstones that win. Only for a step whose output is the bottom
    /// level, where no older value is left for a tombstone to hide.
    pub drop_tombstones: bool,
    /// Close an output run once its entries' `entry_size`s reach this.
    pub target_bytes: usize,
    pub codec: Codec,
    /// About how much of each source to hold, and how many output bytes to
    /// gather before a `Write`.
    pub chunk_bytes: usize,
    /// How much of a run's end to read first, for its footer and index.
    pub tail_bytes: usize,
    /// About how many input bytes to merge before a `Yield`.
    pub yield_bytes: usize,
}

/// A read the host must answer before the next pump: `len` bytes at `offset`
/// of run `run` of source `source`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Demand {
    pub source: u32,
    pub run: u32,
    pub offset: u32,
    pub len: u32,
}

/// Where a pump stopped.
#[derive(Debug, PartialEq, Eq)]
pub enum Stop<'a> {
    /// Read each of these and `feed` it, in any order, then pump.
    Need(&'a [Demand]),
    /// The next bytes of the open output run, valid until the next pump.
    Write(&'a [u8]),
    /// The open output run is complete: every byte of it was in a `Write`.
    RunEnd(&'a RunEnd),
    /// About `yield_bytes` of input were merged since the pump began.
    Yield,
    /// Every input was read and every run's CRC matched. Holds the highest
    /// seq of a dropped tombstone, or 0.
    Done(u64),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MergeError {
    /// An input is not a valid run, or a source's keys go backwards.
    Corrupt(SstError),
    /// A buffer could not grow.
    OutOfMemory,
    /// A pump came before every demand was fed. The session is as it was.
    Unfed,
}

impl From<SstError> for MergeError {
    fn from(e: SstError) -> Self {
        MergeError::Corrupt(e)
    }
}

impl From<OutOfOrder> for MergeError {
    fn from(_: OutOfOrder) -> Self {
        MergeError::Corrupt(SstError::OutOfOrder)
    }
}

impl From<TryReserveError> for MergeError {
    fn from(_: TryReserveError) -> Self {
        MergeError::OutOfMemory
    }
}

/// Room for what `finish` appends past `chunk_bytes`: the last block and
/// the footer. A run's bloom and index can pass it and grow `out`.
const OUT_SLACK: usize = 2 * BLOCK_TARGET;

/// A merge of newest-first sources into key-ordered output runs.
pub struct MergeSession {
    sources: Vec<Source>,
    /// Sources whose `cur` is final for its key: a binary min-heap by
    /// `(cur.key, source)`, so the smallest key and, for a key, the newest
    /// source comes first.
    heap: Vec<u32>,
    /// Sources taken off the heap whose next key is still being read.
    pending: Vec<u32>,
    demands: Vec<Demand>,
    writer: SstWriter,
    out: Vec<u8>,
    output: Output,
    /// The run `RunEnd` reports.
    ended: RunEnd,
    drop_tombstones: bool,
    /// The base manifest's marks block (crates/engine-abi.md, "Wire
    /// formats"), trusted: the host encoded it.
    marks: Vec<u8>,
    target_bytes: usize,
    chunk_bytes: usize,
    yield_bytes: usize,
    /// Framed input bytes opened since the pump began.
    consumed: usize,
    dropped: u64,
    stage: Stage,
}

/// The session between pumps.
enum Stage {
    Running,
    /// `Need` was returned and some demand may still be unfed.
    Feeding,
    /// `Write` handed out `out`, which the next pump clears.
    Writing,
    Done,
    /// Sticky: every later pump returns the error.
    Failed(MergeError),
}

/// The output run.
enum Output {
    /// Open, or not started, with `size` bytes of entries by `entry_size`.
    Filling { size: usize },
    /// Finished into `ended`; what is left of it in `out` goes out first.
    Finished,
}

/// What `run` stopped for. `pump` turns it into a `Stop` borrowing the
/// session.
enum Next {
    Need,
    Write,
    RunEnd,
    Yield,
    Done,
}

impl MergeSession {
    /// A session over `sources`, newest first, each a list of run sizes in
    /// key order, that drops every winner a mark of `marks` covers. Reserves
    /// the working set, so a host that cannot afford it learns so before it
    /// reads anything.
    pub fn open(config: MergeConfig, sources: &[Vec<u32>], marks: &[u8]) -> Result<MergeSession, MergeError> {
        for runs in sources {
            if runs.iter().any(|&size| (size as usize) < FOOTER_BYTES) {
                return Err(MergeError::Corrupt(SstError::TooShort));
            }
        }
        let n = sources.len();
        let mut list = Vec::new();
        list.try_reserve_exact(n)?;
        for (i, runs) in sources.iter().enumerate() {
            list.push(Source::new(i as u32, runs, &config)?);
        }
        let mut heap = Vec::new();
        heap.try_reserve_exact(n)?;
        let mut pending = Vec::new();
        pending.try_reserve_exact(n)?;
        pending.extend(0..n as u32);
        let mut demands = Vec::new();
        demands.try_reserve_exact(n)?;
        let mut out = Vec::new();
        out.try_reserve_exact(config.chunk_bytes.saturating_add(OUT_SLACK))?;
        let mut owned = Vec::new();
        owned.try_reserve_exact(marks.len())?;
        owned.extend_from_slice(marks);
        Ok(MergeSession {
            sources: list,
            heap,
            pending,
            demands,
            writer: SstWriter::new(config.codec),
            out,
            output: Output::Filling { size: 0 },
            ended: RunEnd { entries: 0, size: 0, first_key: Vec::new(), last_key: Vec::new() },
            drop_tombstones: config.drop_tombstones,
            marks: owned,
            target_bytes: config.target_bytes,
            chunk_bytes: config.chunk_bytes.max(1),
            yield_bytes: config.yield_bytes.max(1),
            consumed: 0,
            dropped: 0,
            stage: Stage::Running,
        })
    }

    /// Merge until the host has to act. After `Need`, every demand must be
    /// fed first; a pump before that returns `Unfed` and changes nothing.
    /// Any other error is final: the inputs are corrupt or memory ran out,
    /// and no output of the session may be installed.
    pub fn pump(&mut self) -> Result<Stop<'_>, MergeError> {
        match &self.stage {
            Stage::Failed(e) => return Err(e.clone()),
            Stage::Done => return Ok(Stop::Done(self.dropped)),
            Stage::Feeding => {
                if self.sources.iter().any(|s| matches!(s.reader.ask, Ask::Asked { .. })) {
                    return Err(MergeError::Unfed);
                }
                self.demands.clear();
            }
            Stage::Writing => self.out.clear(),
            Stage::Running => {}
        }
        self.stage = Stage::Running;
        match self.run() {
            Ok(Next::Need) => {
                self.stage = Stage::Feeding;
                Ok(Stop::Need(&self.demands))
            }
            Ok(Next::Write) => {
                self.stage = Stage::Writing;
                Ok(Stop::Write(&self.out))
            }
            Ok(Next::RunEnd) => Ok(Stop::RunEnd(&self.ended)),
            Ok(Next::Yield) => Ok(Stop::Yield),
            Ok(Next::Done) => {
                self.stage = Stage::Done;
                Ok(Stop::Done(self.dropped))
            }
            Err(e) => {
                self.stage = Stage::Failed(e.clone());
                Err(e)
            }
        }
    }

    /// Where the bytes of `source`'s demand go: exactly `len` bytes, to be
    /// filled before the next pump. `None` when `source` has no unfed demand
    /// of that length.
    pub fn feed(&mut self, source: usize, len: usize) -> Option<&mut [u8]> {
        if !matches!(self.stage, Stage::Feeding) {
            return None;
        }
        let reader = &mut self.sources.get_mut(source)?.reader;
        match reader.ask {
            Ask::Asked { len: want, at, .. } if want == len => {
                reader.ask = Ask::Fed { at, len };
                Some(&mut reader.chunk[at..at + len])
            }
            _ => None,
        }
    }

    fn run(&mut self) -> Result<Next, MergeError> {
        self.consumed = 0;
        loop {
            if let Output::Finished = self.output {
                if !self.out.is_empty() {
                    return Ok(Next::Write);
                }
                self.output = Output::Filling { size: 0 };
                return Ok(Next::RunEnd);
            }
            if self.out.len() >= self.chunk_bytes {
                return Ok(Next::Write);
            }
            self.advance_pending()?;
            if !self.demands.is_empty() {
                self.read_ahead()?;
                return Ok(Next::Need);
            }
            if self.consumed >= self.yield_bytes {
                return Ok(Next::Yield);
            }
            if self.heap.is_empty() {
                if self.writer.is_empty() {
                    return Ok(Next::Done);
                }
                self.ended = self.writer.finish(&mut self.out);
                self.output = Output::Finished;
                continue;
            }
            self.next_key()?;
        }
    }

    /// Bring every pending source back to the heap, or list what it must read.
    fn advance_pending(&mut self) -> Result<(), MergeError> {
        let mut i = 0;
        while i < self.pending.len() {
            let s = self.pending[i];
            match self.sources[s as usize].advance(&mut self.consumed)? {
                Advance::Wait(demand) => {
                    self.demands.push(demand);
                    i += 1;
                }
                Advance::Ready => {
                    self.pending.swap_remove(i);
                    heap_push(&mut self.heap, &self.sources, s);
                }
                Advance::Exhausted => {
                    self.pending.swap_remove(i);
                }
            }
        }
        Ok(())
    }

    /// The host is about to read anyway: refill every source running low.
    fn read_ahead(&mut self) -> Result<(), MergeError> {
        for source in &mut self.sources {
            if let Some(demand) = source.reader.read_ahead()? {
                self.demands.push(demand);
            }
        }
        Ok(())
    }

    /// Settle the smallest key: the newest source's entry wins, the same key
    /// in older sources is shadowed, and each of those sources moves on. A
    /// winner a mark covers is dropped in any merge: every older version of
    /// its key has a smaller seq, so the same mark covers it too.
    fn next_key(&mut self) -> Result<(), MergeError> {
        let w = heap_pop(&mut self.heap, &self.sources);
        while let Some(&t) = self.heap.first() {
            if self.sources[t as usize].cur.key != self.sources[w as usize].cur.key {
                break;
            }
            heap_pop(&mut self.heap, &self.sources);
            self.retire(t);
        }
        let winner = &self.sources[w as usize].cur;
        let (mut through, mut o) = (0u64, 4);
        while o < self.marks.len() {
            let start = o + 4;
            let end = start + read_u32(&self.marks, o) as usize;
            let (has_end, mut next) = (self.marks[end] == 1, end + 1);
            let stop = if has_end {
                next += 4 + read_u32(&self.marks, next) as usize;
                &self.marks[end + 5..next]
            } else {
                &[]
            };
            if self.marks[start..end] <= winner.key[..] && (!has_end || winner.key[..] < *stop) {
                through = through.max(u64::from_le_bytes(self.marks[next..next + 8].try_into().unwrap()));
            }
            o = next + 16;
        }
        if through > 0 && winner.seq <= through {
            self.retire(w);
            return Ok(());
        }
        match winner.kind {
            Kind::Del if self.drop_tombstones => self.dropped = self.dropped.max(winner.seq),
            _ => {
                let entry = winner.entry();
                let size = match self.output {
                    Output::Filling { size } => size,
                    Output::Finished => 0,
                } + entry_size(entry);
                self.writer.push(entry, &mut self.out)?;
                self.output = if size >= self.target_bytes {
                    self.ended = self.writer.finish(&mut self.out);
                    Output::Finished
                } else {
                    Output::Filling { size }
                };
            }
        }
        self.retire(w);
        Ok(())
    }

    /// `s`'s `cur` was taken: its next key, already read, becomes `cur`.
    fn retire(&mut self, s: u32) {
        let source = &mut self.sources[s as usize];
        match source.head {
            Head::Ready => {
                mem::swap(&mut source.cur, &mut source.look);
                source.head = Head::Scanning;
                self.pending.push(s);
            }
            _ => source.head = Head::Exhausted,
        }
    }
}

fn before(sources: &[Source], a: u32, b: u32) -> bool {
    match sources[a as usize].cur.key.cmp(&sources[b as usize].cur.key) {
        Ordering::Less => true,
        Ordering::Greater => false,
        Ordering::Equal => a < b,
    }
}

fn heap_push(heap: &mut Vec<u32>, sources: &[Source], s: u32) {
    heap.push(s);
    let mut i = heap.len() - 1;
    while i > 0 && before(sources, heap[i], heap[(i - 1) / 2]) {
        heap.swap(i, (i - 1) / 2);
        i = (i - 1) / 2;
    }
}

fn heap_pop(heap: &mut Vec<u32>, sources: &[Source]) -> u32 {
    let top = heap.swap_remove(0);
    let mut i = 0;
    loop {
        let mut m = i;
        for c in [2 * i + 1, 2 * i + 2] {
            if c < heap.len() && before(sources, heap[c], heap[m]) {
                m = c;
            }
        }
        if m == i {
            return top;
        }
        heap.swap(i, m);
        i = m;
    }
}

/// One input stream and the two entries it has read ahead.
struct Source {
    reader: Reader,
    head: Head,
    cur: Slot,
    look: Slot,
}

/// Where a source stands in finding the last duplicate of its next key.
enum Head {
    /// Nothing read yet.
    Start,
    /// `cur` holds a key; reading on into `look` for later duplicates.
    Scanning,
    /// `cur` is the last duplicate of its key and `look` holds the next key.
    Ready,
    /// `cur` is the last duplicate of the source's last key.
    Last,
    /// Every entry was taken.
    Exhausted,
}

enum Advance {
    /// `cur` is final for its key: the source goes on the heap.
    Ready,
    Exhausted,
    Wait(Demand),
}

impl Source {
    fn new(index: u32, runs: &[u32], config: &MergeConfig) -> Result<Source, MergeError> {
        Ok(Source { reader: Reader::new(index, runs, config)?, head: Head::Start, cur: Slot::new()?, look: Slot::new()? })
    }

    fn advance(&mut self, consumed: &mut usize) -> Result<Advance, MergeError> {
        loop {
            match self.head {
                Head::Start => match self.reader.next(&mut self.cur, consumed)? {
                    Got::Entry => self.head = Head::Scanning,
                    Got::End => {
                        self.head = Head::Exhausted;
                        return Ok(Advance::Exhausted);
                    }
                    Got::Wait(demand) => return Ok(Advance::Wait(demand)),
                },
                Head::Scanning => match self.reader.next(&mut self.look, consumed)? {
                    Got::Entry => match self.look.key.cmp(&self.cur.key) {
                        Ordering::Equal => mem::swap(&mut self.cur, &mut self.look),
                        Ordering::Greater => {
                            self.head = Head::Ready;
                            return Ok(Advance::Ready);
                        }
                        Ordering::Less => return Err(MergeError::Corrupt(SstError::OutOfOrder)),
                    },
                    Got::End => {
                        self.head = Head::Last;
                        return Ok(Advance::Ready);
                    }
                    Got::Wait(demand) => return Ok(Advance::Wait(demand)),
                },
                Head::Ready | Head::Last => return Ok(Advance::Ready),
                Head::Exhausted => return Ok(Advance::Exhausted),
            }
        }
    }
}

#[derive(Clone, Copy)]
enum Kind {
    Put,
    Del,
}

/// An entry copied out of a block, so it outlives the block. Its buffers
/// keep their capacity from one entry to the next.
struct Slot {
    key: Vec<u8>,
    value: Vec<u8>,
    seq: u64,
    kind: Kind,
}

impl Slot {
    fn new() -> Result<Slot, MergeError> {
        let (mut key, mut value) = (Vec::new(), Vec::new());
        key.try_reserve_exact(64)?;
        value.try_reserve_exact(256)?;
        Ok(Slot { key, value, seq: 0, kind: Kind::Del })
    }

    fn fill(&mut self, record: &Record<'_>) -> Result<(), MergeError> {
        self.key.clear();
        self.key.try_reserve(record.prefix.len() + record.suffix.len())?;
        self.key.extend_from_slice(record.prefix);
        self.key.extend_from_slice(record.suffix);
        self.seq = record.seq;
        match record.value {
            Some(value) => {
                self.value.clear();
                self.value.try_reserve(value.len())?;
                self.value.extend_from_slice(value);
                self.kind = Kind::Put;
            }
            None => self.kind = Kind::Del,
        }
        Ok(())
    }

    fn entry(&self) -> EntryRef<'_> {
        match self.kind {
            Kind::Put => EntryRef::Put { key: &self.key, value: &self.value, seq: self.seq },
            Kind::Del => EntryRef::Del { key: &self.key, seq: self.seq },
        }
    }
}

/// What a source is reading of its current run.
enum Read {
    /// The run's tail: its footer and as much of the bloom and index as fit.
    Tail,
    /// The rest of the run's bloom and index. The tail already sits at the
    /// end of `chunk[..size - layout.data_len]`.
    MetaRest(Layout),
    /// Data blocks, in file order.
    Blocks,
    /// Every run of the source was read and checked.
    Done,
}

/// The source's one outstanding read.
enum Ask {
    Idle,
    /// Listed in a `Need`; its bytes go to `chunk[at..at + len]`.
    Asked { offset: usize, len: usize, at: usize },
    /// Fed, not yet taken in.
    Fed { at: usize, len: usize },
}

/// The block being walked.
enum Open {
    None,
    /// A raw block, walked where it sits: `chunk[chunk_pos..chunk_pos + len]`.
    InChunk { len: usize, walk: BlockWalk },
    /// An LZ4 block unpacked into `unpacked[..len]`.
    Unpacked { len: usize, walk: BlockWalk },
}

enum Got {
    Entry,
    End,
    Wait(Demand),
}

/// Reads a source's runs one after the other, a window at a time.
struct Reader {
    index: u32,
    runs: Vec<u32>,
    run: usize,
    read: Read,
    ask: Ask,
    chunk_bytes: usize,
    tail_bytes: usize,

    // The current run, from its footer and index.
    codec: Codec,
    data_len: usize,
    entry_count: usize,
    entries_seen: usize,
    /// Framed length of each data block, in file order. Blocks are
    /// contiguous from offset 0, so their offsets are running sums.
    blocks: Vec<u32>,
    /// Blocks asked for, arrived in `chunk`, and opened, in that order.
    requested: usize,
    arrived: usize,
    opened: usize,
    /// Where block `requested` starts.
    next_offset: usize,

    /// Arrived bytes still needed are `chunk[chunk_pos..chunk_len]`: the
    /// blocks from the open raw one, or from the next to open, to `arrived`.
    chunk: Vec<u8>,
    chunk_pos: usize,
    chunk_len: usize,
    unpacked: Vec<u8>,
    open: Open,

    // The run's CRC covers its data and then its meta, but the meta is read
    // first: the data's CRC streams in as blocks arrive and the two combine.
    crc_data: Crc32,
    data_fed: usize,
    crc_meta: u32,
    meta_crc_len: usize,
    stored_crc: u32,
}

impl Reader {
    fn new(index: u32, runs: &[u32], config: &MergeConfig) -> Result<Reader, MergeError> {
        let mut list = Vec::new();
        list.try_reserve_exact(runs.len())?;
        list.extend_from_slice(runs);
        let chunk_bytes = config.chunk_bytes.max(1);
        let mut chunk = Vec::new();
        grow(&mut chunk, chunk_bytes)?;
        let mut unpacked = Vec::new();
        unpacked.try_reserve_exact(2 * BLOCK_TARGET)?;
        Ok(Reader {
            index,
            runs: list,
            run: 0,
            read: if runs.is_empty() { Read::Done } else { Read::Tail },
            ask: Ask::Idle,
            chunk_bytes,
            tail_bytes: config.tail_bytes.max(FOOTER_BYTES),
            codec: Codec::Raw,
            data_len: 0,
            entry_count: 0,
            entries_seen: 0,
            blocks: Vec::new(),
            requested: 0,
            arrived: 0,
            opened: 0,
            next_offset: 0,
            chunk,
            chunk_pos: 0,
            chunk_len: 0,
            unpacked,
            open: Open::None,
            crc_data: Crc32::new(),
            data_fed: 0,
            crc_meta: 0,
            meta_crc_len: 0,
            stored_crc: 0,
        })
    }

    fn size(&self) -> usize {
        self.runs[self.run] as usize
    }

    /// Read the next entry into `slot`.
    fn next(&mut self, slot: &mut Slot, consumed: &mut usize) -> Result<Got, MergeError> {
        loop {
            match self.read {
                Read::Done => return Ok(Got::End),
                Read::Tail | Read::MetaRest(_) => match self.ask {
                    Ask::Idle => return Ok(Got::Wait(self.ask_tail()?)),
                    Ask::Asked { offset, len, .. } => return Ok(Got::Wait(self.demand(offset, len))),
                    Ask::Fed { at, len } => {
                        self.ask = Ask::Idle;
                        self.take_meta(at, len)?;
                    }
                },
                Read::Blocks => {
                    if self.walk(slot)? {
                        self.entries_seen += 1;
                        return Ok(Got::Entry);
                    }
                    if self.opened == self.blocks.len() {
                        self.end_run()?;
                    } else if self.opened < self.arrived {
                        self.open_block(consumed)?;
                    } else {
                        match self.ask {
                            Ask::Idle => return Ok(Got::Wait(self.ask_data()?)),
                            Ask::Asked { offset, len, .. } => return Ok(Got::Wait(self.demand(offset, len))),
                            Ask::Fed { at, len } => {
                                self.ask = Ask::Idle;
                                self.take_data(at, len)?;
                            }
                        }
                    }
                }
            }
        }
    }

    fn demand(&self, offset: usize, len: usize) -> Demand {
        Demand { source: self.index, run: self.run as u32, offset: offset as u32, len: len as u32 }
    }

    /// The next record of the open block into `slot`, or false once no block
    /// is open.
    fn walk(&mut self, slot: &mut Slot) -> Result<bool, MergeError> {
        let (block, walk) = match &mut self.open {
            Open::None => return Ok(false),
            Open::InChunk { len, walk } => (&self.chunk[self.chunk_pos..self.chunk_pos + *len], walk),
            Open::Unpacked { len, walk } => (&self.unpacked[..*len], walk),
        };
        match walk.next(block)? {
            Some(record) => {
                slot.fill(&record)?;
                Ok(true)
            }
            None => {
                if let Open::InChunk { len, .. } = self.open {
                    self.chunk_pos += len;
                }
                self.open = Open::None;
                Ok(false)
            }
        }
    }

    fn open_block(&mut self, consumed: &mut usize) -> Result<(), MergeError> {
        let len = self.blocks[self.opened] as usize;
        let framed = &self.chunk[self.chunk_pos..self.chunk_pos + len];
        self.open = match self.codec {
            Codec::Raw => Open::InChunk { len, walk: BlockWalk::new(framed)? },
            Codec::Lz4 => {
                let n = unpack_lz4(framed, &mut self.unpacked)?;
                self.chunk_pos += len;
                Open::Unpacked { len: n, walk: BlockWalk::new(&self.unpacked[..n])? }
            }
        };
        self.opened += 1;
        *consumed += len;
        Ok(())
    }

    /// Ask for the run's last `tail_bytes`, which hold its footer.
    fn ask_tail(&mut self) -> Result<Demand, MergeError> {
        let size = self.size();
        let len = size.min(self.tail_bytes);
        self.chunk_pos = 0;
        self.chunk_len = 0;
        if len > self.chunk.len() {
            grow(&mut self.chunk, len)?;
        }
        self.ask = Ask::Asked { offset: size - len, len, at: 0 };
        Ok(self.demand(size - len, len))
    }

    fn take_meta(&mut self, at: usize, len: usize) -> Result<(), MergeError> {
        let size = self.size();
        match self.read {
            Read::MetaRest(layout) => self.parse_meta(&layout, size - layout.data_len),
            _ => {
                let tail_at = size - len;
                let layout = read_footer(&self.chunk[at + len - FOOTER_BYTES..at + len], size)?;
                if layout.data_len < tail_at {
                    // The bloom or index starts before the tail: read the
                    // rest in front of it, so the meta is one slice.
                    let meta_len = size - layout.data_len;
                    if meta_len > self.chunk.len() {
                        grow(&mut self.chunk, meta_len)?;
                    }
                    self.chunk.copy_within(at..at + len, meta_len - len);
                    self.read = Read::MetaRest(layout);
                    self.ask = Ask::Asked { offset: layout.data_len, len: tail_at - layout.data_len, at: 0 };
                    return Ok(());
                }
                self.chunk.copy_within(at..at + len, 0);
                self.parse_meta(&layout, len)?;
                if tail_at == 0 {
                    // The tail is the whole run: keep its blocks.
                    self.chunk_len = layout.data_len;
                    self.take_data_bytes(0, layout.data_len)?;
                    self.requested = self.blocks.len();
                    self.arrived = self.blocks.len();
                    self.next_offset = layout.data_len;
                }
                Ok(())
            }
        }
    }

    /// Check and index the run from its meta: `chunk[..end]` ends with the
    /// run's last bytes and holds all of its bloom, index and footer.
    fn parse_meta(&mut self, layout: &Layout, end: usize) -> Result<(), MergeError> {
        let size = self.size();
        let base = size - end;
        let meta = &self.chunk[layout.data_len - base..end];
        let crc_len = layout.crc_off - layout.data_len;
        self.crc_meta = crc32(&meta[..crc_len]);
        self.meta_crc_len = crc_len;
        self.stored_crc = read_u32(meta, crc_len);
        let index = &meta[layout.index_start - layout.data_len..layout.index_end - layout.data_len];
        index_blocks(index, layout.block_count, layout.data_len, &mut self.blocks)?;

        self.codec = layout.codec;
        self.data_len = layout.data_len;
        self.entry_count = layout.entry_count;
        self.entries_seen = 0;
        self.requested = 0;
        self.arrived = 0;
        self.opened = 0;
        self.next_offset = 0;
        self.chunk_pos = 0;
        self.chunk_len = 0;
        self.crc_data.reset();
        self.data_fed = 0;
        self.read = Read::Blocks;
        if layout.data_len == 0 {
            self.check_crc()?;
        }
        Ok(())
    }

    /// Ask for the next blocks: as many whole ones as fill the chunk to
    /// `chunk_bytes`, and at least one.
    fn ask_data(&mut self) -> Result<Demand, MergeError> {
        if self.chunk_pos > 0 {
            self.chunk.copy_within(self.chunk_pos..self.chunk_len, 0);
            self.chunk_len -= self.chunk_pos;
            self.chunk_pos = 0;
        }
        let room = self.chunk_bytes.saturating_sub(self.chunk_len);
        let (mut len, mut n) = (0, self.requested);
        while n < self.blocks.len() {
            let block = self.blocks[n] as usize;
            if n > self.requested && len + block > room {
                break;
            }
            len += block;
            n += 1;
        }
        if self.chunk_len + len > self.chunk.len() {
            grow(&mut self.chunk, self.chunk_len + len)?;
        }
        let offset = self.next_offset;
        self.ask = Ask::Asked { offset, len, at: self.chunk_len };
        self.requested = n;
        self.next_offset += len;
        Ok(self.demand(offset, len))
    }

    /// A source on the heap that holds less than half a chunk asks for more
    /// while the host is reading for another source anyway.
    fn read_ahead(&mut self) -> Result<Option<Demand>, MergeError> {
        let low = self.chunk_len - self.chunk_pos < self.chunk_bytes / 2;
        if matches!(self.read, Read::Blocks)
            && matches!(self.ask, Ask::Idle)
            && self.requested < self.blocks.len()
            && low
        {
            return Ok(Some(self.ask_data()?));
        }
        Ok(None)
    }

    fn take_data(&mut self, at: usize, len: usize) -> Result<(), MergeError> {
        self.chunk_len = at + len;
        self.arrived = self.requested;
        self.take_data_bytes(at, len)
    }

    fn take_data_bytes(&mut self, at: usize, len: usize) -> Result<(), MergeError> {
        self.crc_data.update(&self.chunk[at..at + len]);
        self.data_fed += len;
        if self.data_fed == self.data_len {
            self.check_crc()?;
        }
        Ok(())
    }

    /// Every data byte has arrived, and none of the last block was used yet.
    fn check_crc(&self) -> Result<(), MergeError> {
        if crc32_combine(self.crc_data.value(), self.crc_meta, self.meta_crc_len) != self.stored_crc {
            return Err(MergeError::Corrupt(SstError::CrcMismatch));
        }
        Ok(())
    }

    fn end_run(&mut self) -> Result<(), MergeError> {
        if self.entries_seen != self.entry_count {
            return Err(MergeError::Corrupt(SstError::CountMismatch));
        }
        self.run += 1;
        self.read = if self.run < self.runs.len() { Read::Tail } else { Read::Done };
        Ok(())
    }
}

/// The framed length of each block, from the index rows
///   u32 len | first key | u32 len | last key | u32 offset | u32 length
/// Blocks must tile the data region from 0, which a run written by
/// `SstWriter` always does, so a block's offset is the sum before it.
fn index_blocks(index: &[u8], count: usize, data_len: usize, blocks: &mut Vec<u32>) -> Result<(), MergeError> {
    blocks.clear();
    // A row is at least 16 bytes, so this bounds the rows that can parse.
    blocks.try_reserve(count.min(index.len() / 16))?;
    let end = index.len();
    let mut o = 0;
    let skip_key = |o: &mut usize| -> Result<(), SstError> {
        if end - *o < 4 {
            return Err(SstError::Truncated);
        }
        let len = read_u32(index, *o) as usize;
        *o += 4;
        if len > end - *o {
            return Err(SstError::Truncated);
        }
        *o += len;
        Ok(())
    };
    let mut next = 0;
    for _ in 0..count {
        skip_key(&mut o)?;
        skip_key(&mut o)?;
        if end - o < 8 {
            return Err(SstError::Truncated.into());
        }
        let offset = read_u32(index, o) as usize;
        let length = read_u32(index, o + 4) as usize;
        o += 8;
        if offset != next || length > data_len - offset {
            return Err(SstError::Truncated.into());
        }
        next += length;
        blocks.push(length as u32);
    }
    if o != end {
        return Err(SstError::TrailingGarbage.into());
    }
    if next != data_len {
        return Err(SstError::Truncated.into());
    }
    Ok(())
}

/// Unpack a framed LZ4 block (u32 size, then LZ4 bytes) into `buf`, which
/// keeps its capacity. Returns the unpacked length.
fn unpack_lz4(framed: &[u8], buf: &mut Vec<u8>) -> Result<usize, MergeError> {
    if framed.len() < 4 {
        return Err(SstError::Truncated.into());
    }
    let size = read_u32(framed, 0) as usize;
    let src = &framed[4..];
    if !lz4_size_fits(src.len(), size) {
        return Err(SstError::BadBlock.into());
    }
    if size > buf.len() {
        grow(buf, size)?;
    }
    match lz4_flex::block::decompress_into(src, &mut buf[..size]) {
        Ok(n) if n == size => Ok(size),
        _ => Err(SstError::BadBlock.into()),
    }
}

/// Make `buf` `len` bytes long without aborting when memory runs out.
fn grow(buf: &mut Vec<u8>, len: usize) -> Result<(), MergeError> {
    buf.try_reserve_exact(len.saturating_sub(buf.len()))?;
    buf.resize(len, 0);
    Ok(())
}

/// One data block of a run, framed as the block index frames it, decoded the
/// way a session reads it.
pub fn decode_block(framed: &[u8], codec: Codec) -> Result<Vec<Entry>, SstError> {
    let mut buf = Vec::new();
    let block = match codec {
        Codec::Raw => framed,
        Codec::Lz4 => match unpack_lz4(framed, &mut buf) {
            Ok(n) => &buf[..n],
            Err(MergeError::Corrupt(e)) => return Err(e),
            Err(_) => return Err(SstError::BadBlock),
        },
    };
    let mut walk = BlockWalk::new(block)?;
    let mut out = Vec::new();
    while let Some(record) = walk.next(block)? {
        out.push(record.entry());
    }
    Ok(out)
}

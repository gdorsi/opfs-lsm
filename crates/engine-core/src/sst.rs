//! SST format, version 3. Data blocks first, then the bloom filter, the
//! block index, the statistics, and a 52-byte footer. Each block stores its shared key
//! prefix once; records hold the suffix and use varint lengths. Magic and
//! version sit in the last 8 bytes.
//! Must stay byte-compatible with `packages/kv/src/store/sst.ts`.

use crate::bloom::{bloom_from_hashes, key_hash};
use crate::crc32::{crc32, Crc32};
use crate::marks::{covers, MarkCursor, Marks};
use crate::stats::StatsBuilder;
use alloc::vec::Vec;
use core::mem;

#[cfg(test)]
mod reference;
#[cfg(test)]
mod writer_tests;

const MAGIC: u32 = 0x4f4c_5354; // OLST
const VERSION: u32 = 3;
pub(crate) const FOOTER_BYTES: usize = 52;
const TAG_PUT: u8 = 1;
const TAG_DEL: u8 = 2;
/// A put with an expiry: a u64 epoch-ms `expires_at` follows the seq.
const TAG_PUT_EXPIRING: u8 = 3;
pub(crate) const BLOCK_TARGET: usize = 4 * 1024;
/// A block stores the offset of every `OFFSET_STRIDE`th record after
/// the first, so a get binary-searches them and walks at most
/// `OFFSET_STRIDE - 1` records. `packages/kv/src/store/sst.ts` uses the
/// same stride.
const OFFSET_STRIDE: usize = 4;

const _: () = assert!(BLOCK_TARGET <= u16::MAX as usize, "a block's offsets are u16");

/// Bytes of a block's offset table: a u16 per sampled record. Only a
/// block of one record can pass the u16 range, and it has no table.
fn offset_table_bytes(count: usize) -> usize {
    2 * (count.saturating_sub(1) / OFFSET_STRIDE)
}

/// How a run stores its data blocks. An LZ4 block is a u32 uncompressed
/// length followed by the LZ4 block-format bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Codec {
    Raw = 0,
    Lz4 = 1,
}

impl Codec {
    fn from_u32(v: u32) -> Result<Codec, SstError> {
        match v {
            0 => Ok(Codec::Raw),
            1 => Ok(Codec::Lz4),
            other => Err(SstError::BadCodec(other)),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
/// `seq` is the WAL seq that wrote the entry. A put with `expires_at` reads
/// as absent from that epoch ms on.
pub enum Entry {
    Put { key: Vec<u8>, value: Vec<u8>, seq: u64, expires_at: Option<u64> },
    Del { key: Vec<u8>, seq: u64 },
}

impl Entry {
    pub fn key(&self) -> &[u8] {
        match self {
            Entry::Put { key, .. } | Entry::Del { key, .. } => key,
        }
    }

    pub fn seq(&self) -> u64 {
        match self {
            Entry::Put { seq, .. } | Entry::Del { seq, .. } => *seq,
        }
    }
}

/// An entry whose bytes stay with the caller. `SstWriter::push` copies what
/// it keeps, so a merge can hand over slices of buffers it reuses for the
/// next entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryRef<'a> {
    Put { key: &'a [u8], value: &'a [u8], seq: u64, expires_at: Option<u64> },
    Del { key: &'a [u8], seq: u64 },
}

impl<'a> EntryRef<'a> {
    pub fn key(&self) -> &'a [u8] {
        match *self {
            EntryRef::Put { key, .. } | EntryRef::Del { key, .. } => key,
        }
    }
}

impl<'a> From<&'a Entry> for EntryRef<'a> {
    fn from(e: &'a Entry) -> Self {
        match e {
            Entry::Put { key, value, seq, expires_at } => EntryRef::Put { key, value, seq: *seq, expires_at: *expires_at },
            Entry::Del { key, seq } => EntryRef::Del { key, seq: *seq },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SstError {
    TooShort,
    BadMagic(u32),
    BadVersion(u32),
    CrcMismatch,
    Truncated,
    BadTag(u8),
    TrailingGarbage,
    CountMismatch,
    BadCodec(u32),
    BadBlock,
    OutOfOrder,
}

impl core::fmt::Display for SstError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl core::error::Error for SstError {}

/// `SstWriter::push` got a key below the one before it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutOfOrder;

impl core::fmt::Display for OutOfOrder {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl core::error::Error for OutOfOrder {}

impl From<OutOfOrder> for SstError {
    fn from(_: OutOfOrder) -> Self {
        SstError::OutOfOrder
    }
}

/// What a writer reports when a run ends: what the manifest records, so
/// nobody reads the run back for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunEnd {
    /// Entries in the run, tombstones included.
    pub entries: usize,
    /// Bytes of the whole run, footer included.
    pub size: usize,
    /// The smallest and largest key. Both are empty when the run has no
    /// entries, and also when its only key is empty, so `entries` says which.
    pub first_key: Vec<u8>,
    pub last_key: Vec<u8>,
    /// The run's statistics section, as the file stores it.
    pub stats: Vec<u8>,
}

/// A run's bytes and its `RunEnd`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncodedRun {
    pub bytes: Vec<u8>,
    pub end: RunEnd,
}

/// Upper bound on an encoded record: tag, seq, expiry, and u32 lengths.
/// On-disk records use varints and a shared prefix, so they are never
/// larger. Compaction cuts runs by this without encoding them.
pub(crate) fn entry_size(e: EntryRef<'_>) -> usize {
    let mut n = 1 + 8 + 4 + e.key().len();
    if let EntryRef::Put { value, expires_at, .. } = e {
        n += 4 + value.len() + expiry_len(expires_at);
    }
    n
}

fn expiry_len(expires_at: Option<u64>) -> usize {
    if expires_at.is_some() {
        8
    } else {
        0
    }
}

pub(crate) fn read_u32(buf: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(buf[o..o + 4].try_into().unwrap())
}

#[cfg(test)]
fn read_u16(buf: &[u8], o: usize) -> u16 {
    u16::from_le_bytes(buf[o..o + 2].try_into().unwrap())
}

fn varint_len(mut v: usize) -> usize {
    let mut n = 1;
    while v >= 0x80 {
        v >>= 7;
        n += 1;
    }
    n
}

fn write_varint(out: &mut Vec<u8>, mut v: usize) {
    while v >= 0x80 {
        out.push(v as u8 | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

/// Unsigned LEB128 of at most 5 bytes, so it fits a u32.
fn read_varint(buf: &[u8], o: &mut usize, end: usize) -> Result<usize, SstError> {
    let mut v = 0usize;
    for shift in (0..35).step_by(7) {
        if *o >= end {
            return Err(SstError::Truncated);
        }
        let b = buf[*o];
        *o += 1;
        v |= ((b & 0x7f) as usize) << shift;
        if b < 0x80 {
            return if v > u32::MAX as usize { Err(SstError::BadBlock) } else { Ok(v) };
        }
    }
    Err(SstError::BadBlock)
}

fn common_prefix(a: &[u8], b: &[u8]) -> usize {
    a.iter().zip(b).take_while(|(x, y)| x == y).count()
}

/// A record's bytes besides its key suffix. The suffix length varint is
/// sized from the whole key, an upper bound that stays fixed as the
/// block prefix shrinks, so a block is sized from running sums.
/// `packages/kv/src/store/sst.ts` sizes blocks the same way.
fn record_overhead(e: EntryRef<'_>) -> usize {
    let n = 1 + 8 + varint_len(e.key().len());
    match e {
        EntryRef::Put { value, expires_at, .. } => n + expiry_len(expires_at) + varint_len(value.len()) + value.len(),
        EntryRef::Del { .. } => n,
    }
}

/// A record of the open block. Its key is staged cut after the `shared` bytes
/// it has in common with the block's first key, because the block's prefix is
/// only known at its last key and can only shrink. A key cut here is never
/// longer than the suffix it will be written with, so staged bytes never pass
/// the block's encoded size however long the keys are.
struct Staged {
    seq: u64,
    shared: usize,
    rest: usize,
    /// None for a tombstone.
    value: Option<usize>,
    expires_at: Option<u64>,
}

/// The bytes a run has emitted so far, and their CRC.
struct Emitted {
    crc: Crc32,
    bytes: usize,
}

impl Emitted {
    fn emit(&mut self, out: &mut Vec<u8>, bytes: &[u8]) {
        self.crc.update(bytes);
        out.extend_from_slice(bytes);
        self.bytes += bytes.len();
    }
}

/// Builds one SST in file order. `push` takes entries in key order and appends
/// each data block to `out` as soon as it is cut. `finish` appends the bloom
/// filter, the index and the footer, and reports the run. While a run is open
/// the writer holds one block, 4 bytes per key for the bloom filter, and the
/// index, however large the run's data grows.
///
/// The writer never reads `out`, so a caller can move the bytes on (to a file,
/// to a result buffer) and clear it between calls. After `finish` the writer
/// is empty and ready for the next run, with its allocations kept.
pub struct SstWriter {
    codec: Codec,
    first: Vec<u8>,
    recs: Vec<Staged>,
    staged: Vec<u8>,
    /// Sum of the open block's key lengths and `record_overhead`s, so the cut
    /// rule is a few additions per entry.
    keys: usize,
    overhead: usize,
    block: Vec<u8>,
    offsets: Vec<u8>,
    framed: Vec<u8>,
    hashes: Vec<u32>,
    /// Index rows as the file stores them.
    index: Vec<u8>,
    sent: Emitted,
    blocks: usize,
    entries: usize,
    first_key: Vec<u8>,
    last_key: Vec<u8>,
    stats: StatsBuilder,
    /// The statistics section of the last run, kept for its capacity.
    stats_bytes: Vec<u8>,
}

impl SstWriter {
    pub fn new(codec: Codec) -> Self {
        SstWriter {
            codec,
            first: Vec::new(),
            recs: Vec::new(),
            staged: Vec::new(),
            keys: 0,
            overhead: 0,
            block: Vec::new(),
            offsets: Vec::new(),
            framed: Vec::new(),
            hashes: Vec::new(),
            index: Vec::new(),
            sent: Emitted { crc: Crc32::new(), bytes: 0 },
            blocks: 0,
            entries: 0,
            first_key: Vec::new(),
            last_key: Vec::new(),
            stats: StatsBuilder::default(),
            stats_bytes: Vec::new(),
        }
    }

    /// True until the first `push` of a run.
    pub fn is_empty(&self) -> bool {
        self.entries == 0
    }

    /// Add the next entry. Keys must not decrease; an equal key is accepted
    /// and written after the one before it. A refused entry leaves the writer
    /// as it was.
    ///
    /// A block holds at most `BLOCK_TARGET` encoded bytes, or one entry. Its
    /// prefix shrinks as keys join it, so its size is recomputed from running
    /// key and overhead sums at each entry; when the entry would overflow it,
    /// the block is cut first and appended to `out`.
    pub fn push(&mut self, e: EntryRef<'_>, out: &mut Vec<u8>) -> Result<(), OutOfOrder> {
        let key = e.key();
        if self.entries > 0 && key < self.last_key.as_slice() {
            return Err(OutOfOrder);
        }
        let mut shared = key.len();
        if !self.recs.is_empty() {
            shared = common_prefix(&self.first, key);
            let n = self.recs.len() + 1;
            let size = 4 + varint_len(shared) + shared + self.overhead + record_overhead(e) + self.keys + key.len()
                - n * shared
                + offset_table_bytes(n);
            if size > BLOCK_TARGET {
                self.cut(out);
                shared = key.len();
            }
        }
        if self.recs.is_empty() {
            self.first.clear();
            self.first.extend_from_slice(key);
        }
        let (seq, value, expires_at) = match e {
            EntryRef::Put { value, seq, expires_at, .. } => (seq, Some(value), expires_at),
            EntryRef::Del { seq, .. } => (seq, None, None),
        };
        self.recs.push(Staged { seq, shared, rest: key.len() - shared, value: value.map(<[u8]>::len), expires_at });
        self.staged.extend_from_slice(&key[shared..]);
        if let Some(value) = value {
            self.staged.extend_from_slice(value);
        }
        self.keys += key.len();
        self.overhead += record_overhead(e);
        self.hashes.push(key_hash(key));
        if self.entries == 0 {
            self.first_key.extend_from_slice(key);
        }
        self.stats.push(key == self.first_key.as_slice(), seq, value.is_none(), expires_at, key.len() + value.map_or(0, <[u8]>::len));
        self.last_key.clear();
        self.last_key.extend_from_slice(key);
        self.entries += 1;
        Ok(())
    }

    /// End the run: close the open block, then append the bloom filter, the
    /// index, the statistics and the footer to `out`. Together with what
    /// `push` appended, `out` holds the run.
    ///   data blocks | bloom bits | block index | statistics | footer (52 bytes)
    /// The footer is u32 entry count, block count, bloom offset, bloom length,
    /// bloom hash count, index offset, index length, codec, statistics
    /// offset, statistics length, then a u32 CRC of every byte before it,
    /// u32 version 3 and u32 magic.
    pub fn finish(&mut self, out: &mut Vec<u8>) -> RunEnd {
        if !self.recs.is_empty() || self.blocks == 0 {
            self.cut(out);
        }
        let data_len = self.sent.bytes;
        let bloom = bloom_from_hashes(&self.hashes, 10);
        self.sent.emit(out, &bloom.bits);
        let index_offset = self.sent.bytes;
        self.sent.emit(out, &self.index);
        let stats_offset = self.sent.bytes;
        let mut stats = mem::take(&mut self.stats_bytes);
        stats.clear();
        self.stats.finish(&self.index, &self.first_key, &mut stats);
        self.sent.emit(out, &stats);

        let mut footer = [0u8; 40];
        let fields = [
            self.entries,
            self.blocks,
            data_len,
            bloom.bits.len(),
            bloom.hash_count as usize,
            index_offset,
            self.index.len(),
            self.codec as usize,
            stats_offset,
            stats.len(),
        ];
        for (slot, field) in footer.chunks_exact_mut(4).zip(fields) {
            slot.copy_from_slice(&(field as u32).to_le_bytes());
        }
        self.sent.emit(out, &footer);
        out.extend_from_slice(&self.sent.crc.value().to_le_bytes());
        out.extend_from_slice(&VERSION.to_le_bytes());
        out.extend_from_slice(&MAGIC.to_le_bytes());

        let end = RunEnd {
            entries: self.entries,
            size: self.sent.bytes + 12,
            first_key: mem::take(&mut self.first_key),
            last_key: mem::take(&mut self.last_key),
            stats: stats.clone(),
        };
        self.stats_bytes = stats;
        self.reset();
        end
    }

    fn reset(&mut self) {
        self.first.clear();
        self.recs.clear();
        self.staged.clear();
        self.keys = 0;
        self.overhead = 0;
        self.hashes.clear();
        self.index.clear();
        self.sent.crc.reset();
        self.sent.bytes = 0;
        self.blocks = 0;
        self.entries = 0;
    }

    /// Write the open block, which may be empty only for a run with no
    /// entries, and append it to `out`.
    ///   u32 count | varint prefixLen | prefix | count records | u16 offsets
    /// The prefix is the longest one shared by every key in the block, which
    /// for sorted keys is the first and last key's. `offsets[j]` is where
    /// record `(j + 1) * OFFSET_STRIDE` starts, from the start of the block.
    /// A record is
    ///   u8 tag | u64 seq | (tag 3) u64 expiresAt | varint suffixLen | suffix
    ///   | (put) varint valLen | value
    /// An LZ4 block is then framed with its uncompressed length.
    fn cut(&mut self, out: &mut Vec<u8>) {
        let p = self.recs.last().map_or(0, |r| r.shared);
        let block = &mut self.block;
        block.clear();
        self.offsets.clear();
        block.extend_from_slice(&(self.recs.len() as u32).to_le_bytes());
        write_varint(block, p);
        block.extend_from_slice(&self.first[..p]);
        let mut at = 0;
        for (i, r) in self.recs.iter().enumerate() {
            if i > 0 && i % OFFSET_STRIDE == 0 {
                self.offsets.extend_from_slice(&(block.len() as u16).to_le_bytes());
            }
            let head = &self.first[p..r.shared];
            let rest = &self.staged[at..at + r.rest];
            at += r.rest;
            block.push(match (r.value, r.expires_at) {
                (None, _) => TAG_DEL,
                (Some(_), None) => TAG_PUT,
                (Some(_), Some(_)) => TAG_PUT_EXPIRING,
            });
            block.extend_from_slice(&r.seq.to_le_bytes());
            if let Some(at) = r.expires_at {
                block.extend_from_slice(&at.to_le_bytes());
            }
            write_varint(block, head.len() + rest.len());
            block.extend_from_slice(head);
            block.extend_from_slice(rest);
            if let Some(len) = r.value {
                write_varint(block, len);
                block.extend_from_slice(&self.staged[at..at + len]);
                at += len;
            }
        }
        block.extend_from_slice(&self.offsets);

        let offset = self.sent.bytes;
        let length = match self.codec {
            Codec::Raw => {
                self.sent.emit(out, &self.block);
                self.block.len()
            }
            Codec::Lz4 => {
                // Into `framed`, which keeps its capacity: `compress` would
                // allocate, zero and shrink a new buffer per block.
                let max = lz4_flex::block::get_maximum_output_size(self.block.len());
                self.framed.clear();
                self.framed.resize(4 + max, 0);
                self.framed[..4].copy_from_slice(&(self.block.len() as u32).to_le_bytes());
                let n = lz4_flex::block::compress_into(&self.block, &mut self.framed[4..])
                    .expect("get_maximum_output_size bounds the output");
                self.framed.truncate(4 + n);
                self.sent.emit(out, &self.framed);
                self.framed.len()
            }
        };
        for key in [&self.first, &self.last_key] {
            self.index.extend_from_slice(&(key.len() as u32).to_le_bytes());
            self.index.extend_from_slice(key);
        }
        self.index.extend_from_slice(&(offset as u32).to_le_bytes());
        self.index.extend_from_slice(&(length as u32).to_le_bytes());

        self.recs.clear();
        self.staged.clear();
        self.keys = 0;
        self.overhead = 0;
        self.blocks += 1;
        self.stats.end_block();
    }
}

/// Stable sort by key. Flushes and merges hand over sorted entries, so the
/// common case is the one pass that checks it. In-crate because core's
/// driftsort is 5 kB of the module.
fn sort_by_key(v: &mut [&Entry]) {
    if v.windows(2).all(|w| w[0].key() <= w[1].key()) {
        return;
    }
    let mut buf = v.to_vec();
    merge_sort(v, &mut buf);
}

/// Top-down merge sort of `v`, using `buf` (same length) as scratch.
fn merge_sort<'a>(v: &mut [&'a Entry], buf: &mut [&'a Entry]) {
    let n = v.len();
    if n <= 16 {
        for i in 1..n {
            let mut j = i;
            while j > 0 && v[j - 1].key() > v[j].key() {
                v.swap(j - 1, j);
                j -= 1;
            }
        }
        return;
    }
    let mid = n / 2;
    merge_sort(&mut v[..mid], &mut buf[..mid]);
    merge_sort(&mut v[mid..], &mut buf[mid..]);
    if v[mid - 1].key() <= v[mid].key() {
        return;
    }
    buf[..n].copy_from_slice(v);
    let (mut i, mut j) = (0, mid);
    for slot in v.iter_mut() {
        // Ties take the left run, which keeps the sort stable.
        if j == n || (i < mid && buf[i].key() <= buf[j].key()) {
            *slot = buf[i];
            i += 1;
        } else {
            *slot = buf[j];
            j += 1;
        }
    }
}

/// Encode SST version 3 (layout in `SstWriter::finish`) from entries in any
/// order, appending the run to `out`. Equal keys keep their order in `entries`.
pub fn encode_run_into(entries: &[Entry], codec: Codec, out: &mut Vec<u8>) -> RunEnd {
    let mut sorted: Vec<&Entry> = entries.iter().collect();
    sort_by_key(&mut sorted);
    let mut writer = SstWriter::new(codec);
    for e in sorted {
        if writer.push(e.into(), out).is_err() {
            unreachable!("sorted entries are in order");
        }
    }
    writer.finish(out)
}

/// `encode_run_into` a new buffer.
pub fn encode_run(entries: &[Entry], codec: Codec) -> EncodedRun {
    let mut bytes = Vec::new();
    let end = encode_run_into(entries, codec, &mut bytes);
    EncodedRun { bytes, end }
}

/// `encode_run`'s bytes.
pub fn encode_sst(entries: &[Entry], codec: Codec) -> Vec<u8> {
    encode_run(entries, codec).bytes
}

/// The smallest record a block can hold: tag, seq, and a one-byte suffix
/// length, as a tombstone whose key is all prefix.
const MIN_RECORD_BYTES: usize = 10;

/// LZ4 writes at most 255 bytes per input byte (each match-length byte adds
/// 255), so a larger `size` is corrupt and is refused before it sizes the
/// output buffer.
pub(crate) fn lz4_size_fits(src_len: usize, size: usize) -> bool {
    size <= src_len.saturating_mul(255).saturating_add(16)
}

/// Unpack one LZ4 block of exactly `size` bytes.
pub fn lz4_unpack(src: &[u8], size: usize) -> Result<Vec<u8>, SstError> {
    if !lz4_size_fits(src.len(), size) {
        return Err(SstError::BadBlock);
    }
    let out = lz4_flex::block::decompress(src, size).map_err(|_| SstError::BadBlock)?;
    if out.len() != size {
        return Err(SstError::BadBlock);
    }
    Ok(out)
}

/// A record of a data block, its key split the way the block stores it.
pub(crate) struct Record<'b> {
    pub(crate) seq: u64,
    pub(crate) prefix: &'b [u8],
    pub(crate) suffix: &'b [u8],
    /// `None` for a tombstone.
    pub(crate) value: Option<&'b [u8]>,
    /// Always `None` for a tombstone.
    pub(crate) expires_at: Option<u64>,
}

impl Record<'_> {
    pub(crate) fn entry(&self) -> Entry {
        let mut key = Vec::with_capacity(self.prefix.len() + self.suffix.len());
        key.extend_from_slice(self.prefix);
        key.extend_from_slice(self.suffix);
        match self.value {
            Some(value) => Entry::Put { key, value: value.to_vec(), seq: self.seq, expires_at: self.expires_at },
            None => Entry::Del { key, seq: self.seq },
        }
    }
}

/// Whether a put with `expires_at` reads as absent at `now`, epoch ms. A
/// `now` of 0 judges nothing: an expiry is at least 1.
pub(crate) fn expired(expires_at: Option<u64>, now: u64) -> bool {
    expires_at.is_some_and(|at| at <= now)
}

/// A cursor over the records of one unpacked data block:
///   u32 count | varint prefixLen | prefix | records | u16 offsets
/// It holds positions only, so the block may move between calls; `next` must
/// be given the bytes `new` read. Lengths are checked as `len > end - o` with
/// `o <= end`, never as `o + len > end`, which wraps for a length near
/// `u32::MAX` on wasm32.
pub(crate) struct BlockWalk {
    o: usize,
    /// Where the offset table starts, which the records must end at.
    end: usize,
    left: usize,
    prefix_at: usize,
    prefix_len: usize,
}

impl BlockWalk {
    pub(crate) fn new(block: &[u8]) -> Result<BlockWalk, SstError> {
        if block.len() < 4 {
            return Err(SstError::Truncated);
        }
        let count = read_u32(block, 0) as usize;
        let end = block.len().checked_sub(offset_table_bytes(count)).ok_or(SstError::Truncated)?;
        let mut o = 4;
        let prefix_len = read_varint(block, &mut o, end)?;
        if prefix_len > end - o {
            return Err(SstError::Truncated);
        }
        Ok(BlockWalk { o: o + prefix_len, end, left: count, prefix_at: o, prefix_len })
    }

    /// The next record, or `None` after the last, once the records are seen
    /// to end exactly where the offset table starts.
    pub(crate) fn next<'b>(&mut self, block: &'b [u8]) -> Result<Option<Record<'b>>, SstError> {
        let (mut o, end) = (self.o, self.end);
        if self.left == 0 {
            return if o == end { Ok(None) } else { Err(SstError::TrailingGarbage) };
        }
        if o >= end {
            return Err(SstError::Truncated);
        }
        let tag = block[o];
        o += 1;
        if end - o < 8 {
            return Err(SstError::Truncated);
        }
        let seq = u64::from_le_bytes(block[o..o + 8].try_into().unwrap());
        o += 8;
        let expires_at = if tag == TAG_PUT_EXPIRING {
            if end - o < 8 {
                return Err(SstError::Truncated);
            }
            let at = u64::from_le_bytes(block[o..o + 8].try_into().unwrap());
            o += 8;
            Some(at)
        } else {
            None
        };
        let key_len = read_varint(block, &mut o, end)?;
        if key_len > end - o {
            return Err(SstError::Truncated);
        }
        let suffix = &block[o..o + key_len];
        o += key_len;
        let value = match tag {
            TAG_PUT | TAG_PUT_EXPIRING => {
                let val_len = read_varint(block, &mut o, end)?;
                if val_len > end - o {
                    return Err(SstError::Truncated);
                }
                let value = &block[o..o + val_len];
                o += val_len;
                Some(value)
            }
            TAG_DEL => None,
            other => return Err(SstError::BadTag(other)),
        };
        self.o = o;
        self.left -= 1;
        let prefix = &block[self.prefix_at..self.prefix_at + self.prefix_len];
        Ok(Some(Record { seq, prefix, suffix, value, expires_at }))
    }
}

/// One unpacked data block, every record of it.
fn read_block(block: &[u8]) -> Result<Vec<Entry>, SstError> {
    let mut walk = BlockWalk::new(block)?;
    let mut out = Vec::with_capacity(walk.left.min((walk.end - walk.o) / MIN_RECORD_BYTES));
    while let Some(record) = walk.next(block)? {
        out.push(record.entry());
    }
    Ok(out)
}

/// True when `hay` holds `needle` as a contiguous run of bytes.
fn contains(hay: &[u8], needle: &[u8]) -> bool {
    let Some((&first, rest)) = needle.split_first() else { return true };
    let mut from = 0;
    while let Some(i) = hay[from..].iter().position(|&b| b == first) {
        let at = from + i + 1;
        if hay.len() - at >= rest.len() && &hay[at..at + rest.len()] == rest {
            return true;
        }
        from = at;
    }
    false
}

/// The puts of one data block of a run, as the block index frames it (`codec`
/// says whether it is a u32 length plus LZ4 bytes or raw), whose value
/// contains every pattern, that have not expired at `now` (epoch ms) and
/// that no mark of `marks` covers. Records are read in place, so a raw block
/// that misses allocates nothing. An LZ4 block is unpacked first, and that
/// unpack is most of the cost of a miss. Hits come back packed: `u32
/// key_len, u32 value_len, key, value`, little-endian, in key order.
pub fn scan_block_contains(
    framed: &[u8],
    codec: Codec,
    patterns: &[&[u8]],
    now: u64,
    marks: Marks<'_>,
) -> Result<Vec<u8>, SstError> {
    let unpacked;
    let block = match codec {
        Codec::Raw => framed,
        Codec::Lz4 => {
            if framed.len() < 4 {
                return Err(SstError::Truncated);
            }
            unpacked = lz4_unpack(&framed[4..], read_u32(framed, 0) as usize)?;
            &unpacked[..]
        }
    };
    let mut walk = BlockWalk::new(block)?;
    let mut cursor = MarkCursor::default();
    let mut out = Vec::new();
    while let Some(record) = walk.next(block)? {
        let Some(value) = record.value else { continue };
        if !expired(record.expires_at, now)
            && !covers(cursor.at(marks, record.prefix, record.suffix), record.seq)
            && patterns.iter().all(|p| contains(value, p))
        {
            out.extend_from_slice(&((record.prefix.len() + record.suffix.len()) as u32).to_le_bytes());
            out.extend_from_slice(&(value.len() as u32).to_le_bytes());
            out.extend_from_slice(record.prefix);
            out.extend_from_slice(record.suffix);
            out.extend_from_slice(value);
        }
    }
    Ok(out)
}

/// Where the sections of a run are, as offsets into the run. Data starts at
/// 0. `crc_off` holds the CRC of every byte before it.
#[derive(Clone, Copy)]
pub(crate) struct Layout {
    pub(crate) entry_count: usize,
    pub(crate) block_count: usize,
    pub(crate) data_len: usize,
    pub(crate) index_start: usize,
    pub(crate) index_end: usize,
    pub(crate) crc_off: usize,
    pub(crate) codec: Codec,
}

/// Check the last `FOOTER_BYTES` of a run of `size` bytes and say where its
/// sections are. The footer is 10 u32 fields, then CRC, version, and magic.
pub(crate) fn read_footer(footer: &[u8], size: usize) -> Result<Layout, SstError> {
    let magic = read_u32(footer, FOOTER_BYTES - 4);
    if magic != MAGIC {
        return Err(SstError::BadMagic(magic));
    }
    let version = read_u32(footer, FOOTER_BYTES - 8);
    if version != VERSION {
        return Err(SstError::BadVersion(version));
    }
    let at = size - FOOTER_BYTES;
    let field = |i: usize| read_u32(footer, 4 * i) as usize;
    let (bloom_offset, bloom_len, index_offset, index_len) = (field(2), field(3), field(5), field(6));
    let (stats_offset, stats_len) = (field(8), field(9));
    if bloom_offset.checked_add(bloom_len) != Some(index_offset)
        || index_offset.checked_add(index_len) != Some(stats_offset)
        || stats_offset.checked_add(stats_len) != Some(at)
    {
        return Err(SstError::Truncated);
    }
    Ok(Layout {
        entry_count: field(0),
        block_count: field(1),
        data_len: bloom_offset,
        index_start: index_offset,
        index_end: stats_offset,
        crc_off: at + 40,
        codec: Codec::from_u32(field(7) as u32)?,
    })
}

fn decode_blocks(buf: &[u8], layout: &Layout) -> Result<Vec<Entry>, SstError> {
    let Layout { entry_count, block_count, data_len, index_start, index_end, codec, .. } = *layout;
    // `index_start <= index_end` (read_footer), and each step keeps
    // `o <= index_end`, so `index_end - o` never wraps.
    let mut o = index_start;
    let skip_key = |o: &mut usize| -> Result<(), SstError> {
        if index_end - *o < 4 {
            return Err(SstError::Truncated);
        }
        let len = read_u32(buf, *o) as usize;
        *o += 4;
        if len > index_end - *o {
            return Err(SstError::Truncated);
        }
        *o += len;
        Ok(())
    };
    // Only a reservation: an LZ4 run can hold more entries than its data
    // bytes allow raw, and the vector grows past it.
    let mut out = Vec::with_capacity(entry_count.min(data_len / MIN_RECORD_BYTES));
    for _ in 0..block_count {
        skip_key(&mut o)?;
        skip_key(&mut o)?;
        if index_end - o < 8 {
            return Err(SstError::Truncated);
        }
        let offset = read_u32(buf, o) as usize;
        let length = read_u32(buf, o + 4) as usize;
        o += 8;
        if offset > data_len || length > data_len - offset {
            return Err(SstError::Truncated);
        }
        let start = offset;
        let end = start + length;
        let unpacked;
        let block = match codec {
            Codec::Raw => &buf[start..end],
            Codec::Lz4 => {
                if length < 4 {
                    return Err(SstError::Truncated);
                }
                unpacked = lz4_unpack(&buf[start + 4..end], read_u32(buf, start) as usize)?;
                &unpacked[..]
            }
        };
        out.extend(read_block(block)?);
    }
    if o != index_end {
        return Err(SstError::TrailingGarbage);
    }
    if out.len() != entry_count {
        return Err(SstError::CountMismatch);
    }
    Ok(out)
}

pub fn decode_sst(buf: &[u8]) -> Result<Vec<Entry>, SstError> {
    if buf.len() < FOOTER_BYTES {
        return Err(SstError::TooShort);
    }
    let layout = read_footer(&buf[buf.len() - FOOTER_BYTES..], buf.len())?;
    if read_u32(buf, layout.crc_off) != crc32(&buf[..layout.crc_off]) {
        return Err(SstError::CrcMismatch);
    }
    decode_blocks(buf, &layout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_keeps_seq() {
        let entries = vec![
            Entry::Put { key: b"b".to_vec(), value: b"2".to_vec(), seq: 7, expires_at: None },
            Entry::Del { key: b"a".to_vec(), seq: 9 },
            Entry::Put { key: b"c".to_vec(), value: b"3".to_vec(), seq: 1 << 40, expires_at: None },
        ];
        let bytes = encode_sst(&entries, Codec::Raw);
        assert_eq!(read_u32(&bytes, bytes.len() - 8), VERSION);
        let decoded = decode_sst(&bytes).unwrap();
        assert_eq!(decoded[0], Entry::Del { key: b"a".to_vec(), seq: 9 });
        assert_eq!(decoded[1], Entry::Put { key: b"b".to_vec(), value: b"2".to_vec(), seq: 7, expires_at: None });
        assert_eq!(decoded[2].seq(), 1 << 40);
    }

    #[test]
    fn a_put_with_an_expiry_round_trips_as_tag_3() {
        let entries = vec![
            Entry::Put { key: b"a".to_vec(), value: b"1".to_vec(), seq: 3, expires_at: Some(1_700_000_000_000) },
            Entry::Put { key: b"b".to_vec(), value: b"2".to_vec(), seq: 4, expires_at: None },
            Entry::Put { key: b"c".to_vec(), value: vec![], seq: 5, expires_at: Some(u64::MAX) },
        ];
        for codec in [Codec::Raw, Codec::Lz4] {
            assert_eq!(decode_sst(&encode_sst(&entries, codec)).unwrap(), entries, "{codec:?}");
        }
        let bytes = encode_sst(&entries[..1], Codec::Raw);
        let record = 4 + 1 + 1;
        assert_eq!(bytes[record], TAG_PUT_EXPIRING);
        assert_eq!(read_u64(&bytes, record + 9), 1_700_000_000_000, "expiry follows the seq");
        assert_eq!(entry_size((&entries[0]).into()), entry_size((&entries[1]).into()) + 8);
    }

    fn read_u64(buf: &[u8], o: usize) -> u64 {
        u64::from_le_bytes(buf[o..o + 8].try_into().unwrap())
    }

    #[test]
    fn a_block_scan_skips_a_put_expired_at_now() {
        let put = |k: &[u8], seq, expires_at| Entry::Put { key: k.to_vec(), value: b"hit".to_vec(), seq, expires_at };
        let entries = vec![put(b"a", 1, Some(10)), put(b"b", 2, Some(11)), put(b"c", 3, None)];
        let sst = encode_sst(&entries, Codec::Raw);
        let layout = read_footer(&sst[sst.len() - FOOTER_BYTES..], sst.len()).unwrap();
        let framed = &sst[..layout.data_len];
        let keys = |now| hits(&scan_block_contains(framed, Codec::Raw, &[b"hit"], now, Marks::NONE).unwrap()).into_iter().map(|(k, _)| k).collect::<Vec<_>>();
        assert_eq!(keys(0), [b"a".to_vec(), b"b".to_vec(), b"c".to_vec()], "now 0 judges nothing");
        assert_eq!(keys(9), [b"a".to_vec(), b"b".to_vec(), b"c".to_vec()]);
        assert_eq!(keys(10), [b"b".to_vec(), b"c".to_vec()], "gone at its deadline");
        assert_eq!(keys(u64::MAX), [b"c".to_vec()]);
    }

    /// Keys share a prefix across each block, so the scan compares a mark's
    /// start against keys it holds in two parts.
    #[test]
    fn a_block_scan_skips_the_puts_a_mark_covers() {
        let key = |i: u64| format!("s/t/{i:08}").into_bytes();
        let entries: Vec<Entry> = (0..400u64).map(|i| put(&key(i), b"hit", i + 1)).collect();
        let (k100, k200, k300) = (key(100), key(200), key(300));
        let marks = crate::marks::block(&[(b"", 0, 0), (&k100, 150, 401), (&k200, 0, 0), (&k300, 1_000, 1_001)]);
        let marks = Marks::parse(&marks).unwrap();
        let live = |i: u64| !((100..150).contains(&i) || i >= 300);
        let want: Vec<Vec<u8>> = (0..400).filter(|&i| live(i)).map(key).collect();
        for codec in [Codec::Raw, Codec::Lz4] {
            let sst = encode_sst(&entries, codec);
            let layout = read_footer(&sst[sst.len() - FOOTER_BYTES..], sst.len()).unwrap();
            assert!(layout.block_count > 1, "{codec:?} spans several blocks");
            let mut got = Vec::new();
            let mut o = layout.index_start;
            for _ in 0..layout.block_count {
                o += 4 + read_u32(&sst, o) as usize;
                o += 4 + read_u32(&sst, o) as usize;
                let (offset, length) = (read_u32(&sst, o) as usize, read_u32(&sst, o + 4) as usize);
                o += 8;
                let framed = &sst[offset..offset + length];
                got.extend(hits(&scan_block_contains(framed, codec, &[b"hit"], 0, marks).unwrap()).into_iter().map(|(k, _)| k));
            }
            assert_eq!(got, want, "{codec:?}");
        }
    }

    #[test]
    fn rejects_a_tag_3_record_cut_inside_its_expiry() {
        let block = [1, 0, 0, 0, 0, TAG_PUT_EXPIRING, 1, 0, 0, 0, 0, 0, 0, 0, 7, 7];
        assert_eq!(read_block(&block), Err(SstError::Truncated));
    }

    fn hits(packed: &[u8]) -> Vec<(Vec<u8>, Vec<u8>)> {
        let mut out = Vec::new();
        let mut o = 0;
        while o < packed.len() {
            let (k, v) = (read_u32(packed, o) as usize, read_u32(packed, o + 4) as usize);
            o += 8;
            out.push((packed[o..o + k].to_vec(), packed[o + k..o + k + v].to_vec()));
            o += k + v;
        }
        out
    }

    #[test]
    fn a_block_scan_returns_the_puts_whose_value_has_every_pattern() {
        let mut entries: Vec<Entry> = (0..400u64)
            .map(|i| put(format!("s/t/{i:08}").as_bytes(), format!(" word{} common{}", i % 7, i % 3).as_bytes(), i + 1))
            .collect();
        entries.push(Entry::Del { key: b"s/t/zzdel".to_vec(), seq: 999 });
        let want = |pats: &[&[u8]]| -> Vec<(Vec<u8>, Vec<u8>)> {
            entries
                .iter()
                .filter_map(|e| match e {
                    Entry::Put { key, value, .. } if pats.iter().all(|p| contains(value, p)) => Some((key.clone(), value.clone())),
                    _ => None,
                })
                .collect()
        };
        for codec in [Codec::Raw, Codec::Lz4] {
            let sst = encode_sst(&entries, codec);
            let layout = read_footer(&sst[sst.len() - FOOTER_BYTES..], sst.len()).unwrap();
            let mut o = layout.index_start;
            let mut got: Vec<Vec<(Vec<u8>, Vec<u8>)>> = vec![vec![]; 4];
            for _ in 0..layout.block_count {
                let first = read_u32(&sst, o) as usize;
                o += 4 + first;
                let last = read_u32(&sst, o) as usize;
                o += 4 + last;
                let (offset, length) = (read_u32(&sst, o) as usize, read_u32(&sst, o + 4) as usize);
                o += 8;
                let framed = &sst[offset..offset + length];
                for (i, pats) in [&[b" word3".as_slice()][..], &[b" word3", b" common0"], &[b" nope"], &[]].iter().enumerate() {
                    got[i].extend(hits(&scan_block_contains(framed, codec, pats, 0, Marks::NONE).unwrap()));
                }
            }
            assert!(layout.block_count > 1, "{codec:?} spans several blocks");
            assert_eq!(got[0], want(&[b" word3"]), "{codec:?}");
            assert_eq!(got[1], want(&[b" word3", b" common0"]), "{codec:?}");
            assert!(got[2].is_empty(), "{codec:?}");
            assert_eq!(got[3].len(), 400, "no patterns keeps every put, and no tombstone");
        }
    }

    #[test]
    fn contains_matches_overlapping_starts() {
        assert!(contains(b"aab", b"ab"));
        assert!(contains(b" a a ab", b" ab"));
        assert!(!contains(b"ab", b"abc"));
        assert!(contains(b"", b""));
    }

    fn put(key: &[u8], value: &[u8], seq: u64) -> Entry {
        Entry::Put { key: key.to_vec(), value: value.to_vec(), seq, expires_at: None }
    }

    fn round_trip(entries: Vec<Entry>) {
        let mut sorted = entries.clone();
        sorted.sort_by(|a, b| a.key().cmp(b.key()));
        for codec in [Codec::Raw, Codec::Lz4] {
            assert_eq!(decode_sst(&encode_sst(&entries, codec)).unwrap(), sorted, "{codec:?}");
        }
    }

    #[test]
    fn round_trips_edge_shapes() {
        round_trip(vec![]);
        round_trip(vec![put(b"only", b"v", 1)]);
        round_trip(vec![put(b"", b"empty key", 1), put(b"a", b"", 2), Entry::Del { key: b"ab".to_vec(), seq: 3 }]);
        round_trip(vec![put(b"apple", b"1", 1), put(b"zebra", b"2", 2), put(b"mango", b"3", 3)]);
        round_trip(vec![put(&[0xff; 300], &[7; 200], 1), put(&[0xff; 301], b"", u64::MAX)]);
    }

    /// Index keys as collections writes them: a long head every key shares.
    fn index_rows(n: u64) -> Vec<Entry> {
        (0..n)
            .map(|i| put(format!("i/\x05\0todos\x09\0byCreated{:016x}{i:08}", 1_700_000 + i / 3).as_bytes(), b"", i))
            .collect()
    }

    #[test]
    fn a_block_stores_its_shared_prefix_once() {
        let entries = index_rows(1);
        let key = entries[0].key().to_vec();
        let bytes = encode_sst(&entries, Codec::Raw);
        assert_eq!(bytes[4] as usize, key.len(), "prefix length varint");
        assert_eq!(&bytes[5..5 + key.len()], &key[..], "a lone key is all prefix");
        assert_eq!(&bytes[5 + key.len()..5 + key.len() + 11], &[TAG_PUT, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

        let many = index_rows(3_000);
        let bytes = encode_sst(&many, Codec::Raw);
        let raw: usize = many.iter().map(|e| entry_size(e.into())).sum();
        assert!(bytes.len() * 2 < raw, "{} vs {raw} record bytes", bytes.len());
        assert_eq!(decode_sst(&bytes).unwrap(), many);
    }

    #[test]
    fn blocks_fill_to_the_target_in_encoded_bytes() {
        let bytes = encode_sst(&index_rows(3_000), Codec::Raw);
        let footer = bytes.len() - FOOTER_BYTES;
        let (blocks, data_len) = (read_u32(&bytes, footer + 4) as usize, read_u32(&bytes, footer + 8) as usize);
        assert!(blocks > 1);
        assert!(data_len / blocks > BLOCK_TARGET * 9 / 10, "{} bytes per block", data_len / blocks);
        assert!(data_len / blocks <= BLOCK_TARGET);
    }

    #[test]
    fn offsets_point_at_every_stride_th_record() {
        let entries = index_rows(3_000);
        let bytes = encode_sst(&entries, Codec::Raw);
        let index_start = read_u32(&bytes, bytes.len() - FOOTER_BYTES + 4 * 5) as usize;
        let o = index_start + 4 + read_u32(&bytes, index_start) as usize;
        let length = read_u32(&bytes, o + 4 + read_u32(&bytes, o) as usize + 4) as usize;
        let block = &bytes[..length];
        let count = read_u32(block, 0) as usize;
        assert!(count > OFFSET_STRIDE, "{count} records");
        let table = length - offset_table_bytes(count);
        let records = read_block(block).unwrap();
        for j in 1..=(count - 1) / OFFSET_STRIDE {
            let at = read_u16(block, table + 2 * (j - 1)) as usize;
            let mut walk = BlockWalk::new(block).unwrap();
            (walk.o, walk.left) = (at, count - j * OFFSET_STRIDE);
            let mut rest = Vec::new();
            while let Some(record) = walk.next(block).unwrap() {
                rest.push(record.entry());
            }
            assert_eq!(rest, records[j * OFFSET_STRIDE..], "offset {j}");
        }
    }

    #[test]
    fn a_record_past_u16_offsets_gets_a_block_of_its_own() {
        let big = vec![7u8; 70_000];
        round_trip(vec![put(b"a", b"1", 1), put(b"b", &big, 2), put(b"c", b"3", 3)]);
        let bytes = encode_sst(&[put(b"a", b"1", 1), put(b"b", &big, 2), put(b"c", b"3", 3)], Codec::Raw);
        assert_eq!(read_u32(&bytes, bytes.len() - FOOTER_BYTES + 4), 3, "one block per entry");
    }

    #[test]
    fn rejects_an_overlong_varint() {
        let mut bytes = encode_sst(&[put(b"a", b"1", 7)], Codec::Raw);
        bytes[4..10].fill(0xff);
        let crc_off = bytes.len() - 12;
        let sum = crc32(&bytes[..crc_off]);
        bytes[crc_off..crc_off + 4].copy_from_slice(&sum.to_le_bytes());
        assert!(decode_sst(&bytes).is_err());
    }

    fn todo_rows(n: u64) -> Vec<Entry> {
        (0..n)
            .map(|i| Entry::Put {
                key: format!("todo/{i:013}").into_bytes(),
                value: format!("{{\"title\":\"buy milk {}\",\"done\":false}}", i % 7).into_bytes(),
                seq: i,
                expires_at: None,
            })
            .collect()
    }

    #[test]
    fn lz4_round_trips_and_shrinks_the_run() {
        let entries = todo_rows(2_000);
        let raw = encode_sst(&entries, Codec::Raw);
        let packed = encode_sst(&entries, Codec::Lz4);
        assert_eq!(read_u32(&packed, packed.len() - 24), Codec::Lz4 as u32);
        assert!(packed.len() * 2 < raw.len(), "{} vs {}", packed.len(), raw.len());
        assert_eq!(decode_sst(&packed).unwrap(), decode_sst(&raw).unwrap());
    }

    #[test]
    fn lz4_round_trips_an_empty_run() {
        assert_eq!(decode_sst(&encode_sst(&[], Codec::Lz4)).unwrap(), vec![]);
    }

    #[test]
    fn rejects_a_corrupt_lz4_block_even_with_a_matching_crc() {
        let mut bytes = encode_sst(&todo_rows(200), Codec::Lz4);
        for b in &mut bytes[4..40] {
            *b = 0xff;
        }
        let crc_off = bytes.len() - 12;
        let sum = crc32(&bytes[..crc_off]);
        bytes[crc_off..crc_off + 4].copy_from_slice(&sum.to_le_bytes());
        assert!(decode_sst(&bytes).is_err());
    }

    #[test]
    fn lz4_unpack_takes_the_largest_ratio_and_refuses_past_it() {
        // Zeros compress about as far as LZ4 goes: just under 255 to 1.
        let plain = vec![0u8; 1 << 20];
        let packed = lz4_flex::block::compress(&plain);
        assert!(plain.len() <= 255 * packed.len() + 16, "ratio {}", plain.len() / packed.len());
        assert_eq!(lz4_unpack(&packed, plain.len()).unwrap(), plain);
        assert_eq!(lz4_unpack(&[0x10, 0x41], 255 * 2 + 17), Err(SstError::BadBlock));
    }

    #[test]
    fn rejects_an_unknown_codec() {
        let mut bytes = encode_sst(&todo_rows(3), Codec::Raw);
        let at = bytes.len() - 24;
        bytes[at] = 9;
        let crc_off = bytes.len() - 12;
        let sum = crc32(&bytes[..crc_off]);
        bytes[crc_off..crc_off + 4].copy_from_slice(&sum.to_le_bytes());
        assert_eq!(decode_sst(&bytes), Err(SstError::BadCodec(9)));
    }

    #[test]
    fn data_comes_first_and_the_footer_last() {
        let entries = vec![Entry::Put { key: b"a".to_vec(), value: b"1".to_vec(), seq: 7, expires_at: None }];
        let bytes = encode_sst(&entries, Codec::Raw);
        assert_eq!(read_u32(&bytes, 0), 1, "first block's record count");
        assert_eq!(read_u32(&bytes, bytes.len() - 4), MAGIC);
    }

    #[test]
    fn rejects_a_flipped_data_byte() {
        let entries = vec![Entry::Put { key: b"a".to_vec(), value: b"1".to_vec(), seq: 7, expires_at: None }];
        let mut bytes = encode_sst(&entries, Codec::Raw);
        bytes[5] ^= 0xff;
        assert_eq!(decode_sst(&bytes), Err(SstError::CrcMismatch));
    }

    #[test]
    fn multi_block() {
        let mut entries = Vec::new();
        for i in 0..200 {
            let key = format!("k{i:04}").into_bytes();
            entries.push(Entry::Put { key, value: vec![b'x'; 64], seq: i, expires_at: None });
        }
        let bytes = encode_sst(&entries, Codec::Raw);
        let block_count = read_u32(&bytes, bytes.len() - FOOTER_BYTES + 4);
        assert!(block_count > 1, "expected multiple blocks, got {block_count}");
        let decoded = decode_sst(&bytes).unwrap();
        assert_eq!(decoded.len(), 200);
        assert_eq!(decoded[199].seq(), 199);
    }

    #[test]
    fn bloom_past_64_kib() {
        let entries: Vec<Entry> = (0..60_000u64)
            .map(|i| Entry::Put { key: format!("k{i:08}").into_bytes(), value: b"v".to_vec(), seq: i, expires_at: None })
            .collect();
        let bytes = encode_sst(&entries, Codec::Raw);
        assert!(read_u32(&bytes, bytes.len() - FOOTER_BYTES + 12) > u16::MAX as u32);
        assert_eq!(decode_sst(&bytes).unwrap().len(), 60_000);
    }
}

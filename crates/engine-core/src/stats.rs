//! Run statistics: how a run's entry bytes spread by seq, by expiry and by
//! key, so the compaction planner sizes dead bytes from the manifest alone.
//! Layout in docs/sst-format.md, "Statistics". Must stay byte-compatible
//! with `packages/kv/src/store/run-stats.ts`.

use alloc::vec::Vec;

/// Points of a spread: the smallest value, the values at 1/8 to 7/8 of the
/// bytes, and the largest value.
pub(crate) const POINTS: usize = 9;

/// One entry's value on an axis and its entry bytes. 12 bytes, so the
/// builder holds 12 bytes per entry of the open run, besides the 4 of its
/// bloom hash.
#[derive(Clone, Copy)]
#[repr(C, packed(4))]
struct Weighted {
    at: u64,
    bytes: u32,
}

/// Builds the statistics of the open run in one pass over its entries in
/// key order. Holds a `Weighted` per entry for the seq spread, one per put
/// with an expiry, and the entry bytes at the end of each data block; the
/// key points are the last keys of blocks, read from the index at `finish`.
#[derive(Default)]
pub(crate) struct StatsBuilder {
    entries: u32,
    entry_bytes: u64,
    tombstones: u32,
    tombstone_bytes: u64,
    /// Entry bytes of the entries with the run's first key.
    first_bytes: u64,
    by_seq: Vec<Weighted>,
    by_expiry: Vec<Weighted>,
    block_ends: Vec<u64>,
}

impl StatsBuilder {
    /// `bytes` is the entry's key length plus value length. `first_key`:
    /// its key is the run's first.
    pub(crate) fn push(&mut self, first_key: bool, seq: u64, tombstone: bool, expires_at: Option<u64>, bytes: usize) {
        let bytes = bytes as u64;
        if first_key {
            self.first_bytes += bytes;
        }
        self.entries += 1;
        self.entry_bytes += bytes;
        if tombstone {
            self.tombstones += 1;
            self.tombstone_bytes += bytes;
        }
        self.by_seq.push(Weighted { at: seq, bytes: bytes as u32 });
        if let Some(at) = expires_at {
            self.by_expiry.push(Weighted { at, bytes: bytes as u32 });
        }
    }

    /// The open block was cut after the last entry pushed.
    pub(crate) fn end_block(&mut self) {
        self.block_ends.push(self.entry_bytes);
    }

    /// Append the statistics section to `out` and reset. `index` is the
    /// run's block index as the file stores it, one row per `end_block`.
    pub(crate) fn finish(&mut self, index: &[u8], first_key: &[u8], out: &mut Vec<u8>) {
        for n in [self.entries as u64, self.entry_bytes, self.tombstones as u64, self.tombstone_bytes] {
            out.extend_from_slice(&(n as u32).to_le_bytes());
        }
        numeric(&mut self.by_seq, out);
        numeric(&mut self.by_expiry, out);
        self.keys(index, first_key, out);
        self.entries = 0;
        self.entry_bytes = 0;
        self.tombstones = 0;
        self.tombstone_bytes = 0;
        self.first_bytes = 0;
        self.by_seq.clear();
        self.by_expiry.clear();
        self.block_ends.clear();
    }

    /// Point 0 is the first key. Point j of 1 to 8 is the last key of the
    /// first block whose end holds at least j/8 of the entry bytes, so
    /// point 8 is the last key.
    fn keys(&self, index: &[u8], first_key: &[u8], out: &mut Vec<u8>) {
        if self.entries == 0 {
            out.push(0);
            return;
        }
        out.push(POINTS as u8);
        let point = |out: &mut Vec<u8>, key: &[u8], through: u64| {
            out.extend_from_slice(&(key.len() as u32).to_le_bytes());
            out.extend_from_slice(key);
            out.extend_from_slice(&(through as u32).to_le_bytes());
        };
        point(out, first_key, self.first_bytes);
        let total = self.entry_bytes;
        let mut level = 1u64;
        let mut o = 0;
        for &end in &self.block_ends {
            let first = read_u32(index, o);
            o += 4 + first;
            let last = read_u32(index, o);
            let key = &index[o + 4..o + 4 + last];
            o += 4 + last + 8;
            while level < POINTS as u64 && 8 * end >= level * total {
                point(out, key, end);
                level += 1;
            }
        }
    }
}

fn read_u32(buf: &[u8], o: usize) -> usize {
    u32::from_le_bytes(buf[o..o + 4].try_into().unwrap()) as usize
}

/// A spread of `items`: none when empty, else the smallest value, the
/// smallest value at or below which lie j/8 of the bytes for j of 1 to 7,
/// and the largest value, each with the bytes at or below it.
fn numeric(items: &mut [Weighted], out: &mut Vec<u8>) {
    if items.is_empty() {
        out.push(0);
        return;
    }
    items.sort_unstable_by_key(|w| w.at);
    out.push(POINTS as u8);
    let total: u64 = items.iter().map(|w| w.bytes as u64).sum();
    let point = |out: &mut Vec<u8>, at: u64, through: u64| {
        out.extend_from_slice(&at.to_le_bytes());
        out.extend_from_slice(&(through as u32).to_le_bytes());
    };
    let (mut level, mut cum, mut i) = (1u64, 0u64, 0);
    while i < items.len() {
        let at = items[i].at;
        while i < items.len() && items[i].at == at {
            cum += items[i].bytes as u64;
            i += 1;
        }
        if at == items[0].at {
            point(out, at, cum);
        }
        while level < 8 && 8 * cum >= level * total {
            point(out, at, cum);
            level += 1;
        }
    }
    point(out, items[items.len() - 1].at, total);
}

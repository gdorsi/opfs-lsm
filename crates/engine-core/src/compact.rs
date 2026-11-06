//! SST merge for compaction (newest-first inputs).

use crate::sst::{decode_sst, encode_sst, entry_size, Codec, Entry, SstError};
use std::cmp::Ordering;
use std::collections::binary_heap::{BinaryHeap, PeekMut};

/// The next entry of input `run`. Ordered so the max-heap pops the smallest
/// key first and, for one key, the newest run first.
struct Head {
    entry: Entry,
    run: usize,
}

impl Ord for Head {
    fn cmp(&self, other: &Self) -> Ordering {
        other.entry.key().cmp(self.entry.key()).then(other.run.cmp(&self.run))
    }
}

impl PartialOrd for Head {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for Head {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for Head {}

/// Merge newest-first runs into runs of about `target_bytes` each, split at
/// key boundaries and written with `codec`. Newer entries win.
/// `drop_tombstones` is for a merge that includes the oldest run, where no
/// older value is left for a tombstone to hide. Returns the runs in key
/// order and the highest seq of a dropped tombstone, 0 when none was dropped.
pub fn merge_sst_bytes(
    sst_bytes: &[Vec<u8>],
    drop_tombstones: bool,
    target_bytes: usize,
    codec: Codec,
) -> Result<(Vec<Vec<u8>>, u64), SstError> {
    let mut inputs = sst_bytes
        .iter()
        .map(|bytes| decode_sst(bytes).map(Vec::into_iter))
        .collect::<Result<Vec<_>, _>>()?;
    let mut heap = BinaryHeap::with_capacity(inputs.len());
    for (run, input) in inputs.iter_mut().enumerate() {
        if let Some(entry) = input.next() {
            heap.push(Head { entry, run });
        }
    }

    let mut dropped = 0u64;
    let mut runs = Vec::new();
    let mut pending = Vec::new();
    let mut size = 0;
    while let Some(Head { entry, run }) = heap.pop() {
        if let Some(next) = inputs[run].next() {
            heap.push(Head { entry: next, run });
        }
        while let Some(mut shadowed) = heap.peek_mut() {
            if shadowed.entry.key() != entry.key() {
                break;
            }
            match inputs[shadowed.run].next() {
                Some(next) => shadowed.entry = next,
                None => {
                    PeekMut::pop(shadowed);
                }
            }
        }
        if drop_tombstones && matches!(entry, Entry::Del { .. }) {
            dropped = dropped.max(entry.seq());
            continue;
        }
        size += entry_size(&entry);
        pending.push(entry);
        if size >= target_bytes {
            runs.push(encode_sst(&pending, codec));
            pending.clear();
            size = 0;
        }
    }
    if !pending.is_empty() {
        runs.push(encode_sst(&pending, codec));
    }
    Ok((runs, dropped))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put(k: &[u8], v: &[u8], seq: u64) -> Entry {
        Entry::Put { key: k.to_vec(), value: v.to_vec(), seq }
    }

    #[test]
    fn newer_wins() {
        let older = encode_sst(&[put(b"k", b"old", 1)], Codec::Raw);
        let newer = encode_sst(&[put(b"k", b"new", 2)], Codec::Raw);
        let (out, dropped) = merge_sst_bytes(&[newer, older], false, usize::MAX, Codec::Raw).unwrap();
        assert_eq!(decode_sst(&out[0]).unwrap(), vec![put(b"k", b"new", 2)]);
        assert_eq!(dropped, 0);
    }

    #[test]
    fn bottom_merge_drops_tombstones() {
        let older = encode_sst(&[put(b"a", b"1", 1), put(b"b", b"1", 1)], Codec::Raw);
        let newer = encode_sst(&[Entry::Del { key: b"a".to_vec(), seq: 5 }], Codec::Raw);
        let (kept, _) = merge_sst_bytes(&[newer.clone(), older.clone()], false, usize::MAX, Codec::Raw).unwrap();
        assert_eq!(
            decode_sst(&kept[0]).unwrap(),
            vec![Entry::Del { key: b"a".to_vec(), seq: 5 }, put(b"b", b"1", 1)]
        );
        let (out, dropped) = merge_sst_bytes(&[newer, older], true, usize::MAX, Codec::Raw).unwrap();
        assert_eq!(decode_sst(&out[0]).unwrap(), vec![put(b"b", b"1", 1)]);
        assert_eq!(dropped, 5);
    }

    #[test]
    fn splits_output_at_key_boundaries() {
        let entries: Vec<Entry> = (0..100u64)
            .map(|i| put(format!("k{i:03}").as_bytes(), &[b'x'; 50], i))
            .collect();
        let (out, _) = merge_sst_bytes(&[encode_sst(&entries, Codec::Raw)], false, 1000, Codec::Raw).unwrap();
        assert!(out.len() > 1);
        let back: Vec<Entry> = out.iter().flat_map(|r| decode_sst(r).unwrap()).collect();
        assert_eq!(back, entries);
        let (none, _) = merge_sst_bytes(&[encode_sst(&[Entry::Del { key: b"a".to_vec(), seq: 1 }], Codec::Raw)], true, 1000, Codec::Raw).unwrap();
        assert!(none.is_empty());
    }

    #[test]
    fn newest_of_many_overlapping_runs_wins() {
        let runs: Vec<Vec<Entry>> = (0..3u64)
            .map(|r| (0..30u64).filter(|i| i % (r + 1) == 0).map(|i| put(format!("k{i:02}").as_bytes(), &[b'0' + r as u8], 10 - r)).collect())
            .collect();
        let blobs: Vec<Vec<u8>> = runs.iter().map(|r| encode_sst(r, Codec::Raw)).collect();
        let (out, _) = merge_sst_bytes(&blobs, false, 200, Codec::Raw).unwrap();
        let back: Vec<Entry> = out.iter().flat_map(|r| decode_sst(r).unwrap()).collect();
        let want: Vec<Entry> = (0..30u64).map(|i| put(format!("k{i:02}").as_bytes(), b"0", 10)).collect();
        assert_eq!(back, want);
        let (reversed, _) = merge_sst_bytes(&blobs.iter().rev().cloned().collect::<Vec<_>>(), false, usize::MAX, Codec::Raw).unwrap();
        let newest = |i: u64| [2u64, 1, 0].into_iter().find(|r| i % (r + 1) == 0).unwrap();
        let want: Vec<Entry> = (0..30u64).map(|i| put(format!("k{i:02}").as_bytes(), &[b'0' + newest(i) as u8], 10 - newest(i))).collect();
        assert_eq!(decode_sst(&reversed[0]).unwrap(), want);
    }

    #[test]
    fn writes_the_codec_it_is_given_and_reads_either() {
        let entries: Vec<Entry> = (0..300u64)
            .map(|i| put(format!("k{i:03}").as_bytes(), &[b'x'; 40], i))
            .collect();
        let raw = encode_sst(&entries, Codec::Raw);
        let (packed, _) = merge_sst_bytes(&[raw.clone()], false, usize::MAX, Codec::Lz4).unwrap();
        assert!(packed[0].len() < raw.len() / 2);
        let (back, _) = merge_sst_bytes(&packed, false, usize::MAX, Codec::Raw).unwrap();
        assert_eq!(back[0], raw);
    }
}

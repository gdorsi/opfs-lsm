//! SST merge for compaction (newest-first inputs).

use crate::sst::{decode_sst, encode_sst, entry_size, Codec, Entry, SstError};
use alloc::vec::Vec;

/// The next entry of input `run`.
struct Head {
    entry: Entry,
    run: usize,
}

/// Pops the smallest key first and, for one key, the newest run first.
fn before(a: &Head, b: &Head) -> bool {
    (a.entry.key(), a.run) < (b.entry.key(), b.run)
}

/// A binary min-heap of run heads. In-crate because `BinaryHeap` is about
/// 2 kB of the module and the merge needs only its top, replace and remove.
struct Heads(Vec<Head>);

impl Heads {
    fn top(&self) -> Option<&Head> {
        self.0.first()
    }

    fn push(&mut self, h: Head) {
        let v = &mut self.0;
        v.push(h);
        let mut i = v.len() - 1;
        while i > 0 && before(&v[i], &v[(i - 1) / 2]) {
            v.swap(i, (i - 1) / 2);
            i = (i - 1) / 2;
        }
    }

    /// Put `next` in place of the top, or drop the top when `next` is `None`,
    /// and restore the order. Returns the old top.
    fn replace_top(&mut self, next: Option<Head>) -> Head {
        let v = &mut self.0;
        let old = match next {
            Some(h) => core::mem::replace(&mut v[0], h),
            None => v.swap_remove(0),
        };
        let mut i = 0;
        loop {
            let mut m = i;
            for c in [2 * i + 1, 2 * i + 2] {
                if c < v.len() && before(&v[c], &v[m]) {
                    m = c;
                }
            }
            if m == i {
                return old;
            }
            v.swap(i, m);
            i = m;
        }
    }
}

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
    let mut heap = Heads(Vec::with_capacity(inputs.len()));
    for (run, input) in inputs.iter_mut().enumerate() {
        if let Some(entry) = input.next() {
            heap.push(Head { entry, run });
        }
    }

    let mut dropped = 0u64;
    let mut runs = Vec::new();
    let mut pending = Vec::new();
    let mut size = 0;
    while let Some(&Head { run, .. }) = heap.top() {
        // Equal keys sit together. The later one in this run wins, as the
        // BTreeMap insert did. The run's first strictly greater key replaces it.
        let mut entry = None;
        let next_after = loop {
            match inputs[run].next() {
                Some(next) if next.key() == heap.top().unwrap().entry.key() => entry = Some(next),
                other => break other,
            }
        };
        let Head { entry: first, .. } = heap.replace_top(next_after.map(|entry| Head { entry, run }));
        let entry = entry.unwrap_or(first);
        // Older runs holding the same key are shadowed: skip past it in each.
        while let Some(shadowed) = heap.top() {
            if shadowed.entry.key() != entry.key() {
                break;
            }
            let shadowed_run = shadowed.run;
            let replacement = loop {
                match inputs[shadowed_run].next() {
                    Some(next) if next.key() == entry.key() => continue,
                    other => break other,
                }
            };
            heap.replace_top(replacement.map(|entry| Head { entry, run: shadowed_run }));
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

    /// The heap replaced a `BTreeMap` that kept the last entry written for a
    /// key. Later duplicates in the winning run must win too, including a put
    /// that follows a delete of the same key.
    #[test]
    fn last_duplicate_in_the_newest_run_wins() {
        let newest = encode_sst(
            &[
                put(b"a", b"first", 1),
                Entry::Del { key: b"a".to_vec(), seq: 2 },
                put(b"a", b"last", 3),
                put(b"b", b"b", 4),
            ],
            Codec::Raw,
        );
        let older = encode_sst(
            &[put(b"a", b"old", 9), Entry::Del { key: b"a".to_vec(), seq: 8 }, put(b"b", b"old-b", 1)],
            Codec::Raw,
        );
        let (out, dropped) = merge_sst_bytes(&[newest.clone(), older.clone()], false, usize::MAX, Codec::Raw).unwrap();
        assert_eq!(decode_sst(&out[0]).unwrap(), vec![put(b"a", b"last", 3), put(b"b", b"b", 4)]);
        assert_eq!(dropped, 0);
        let (out, dropped) = merge_sst_bytes(&[newest, older], true, 1, Codec::Raw).unwrap();
        assert_eq!(dropped, 0);
        let back: Vec<Entry> = out.iter().flat_map(|r| decode_sst(r).unwrap()).collect();
        assert_eq!(back, vec![put(b"a", b"last", 3), put(b"b", b"b", 4)]);

        // A later tombstone in the same run is the one that wins. Dropping it
        // must remove the key and report that tombstone's seq, not the earlier put.
        let newest_del = encode_sst(&[put(b"a", b"first", 1), Entry::Del { key: b"a".to_vec(), seq: 6 }], Codec::Raw);
        let (out, dropped) = merge_sst_bytes(&[newest_del], true, usize::MAX, Codec::Raw).unwrap();
        assert!(out.is_empty());
        assert_eq!(dropped, 6);
    }

    /// Byte-identical to the BTreeMap merge: newest run wins, the last
    /// duplicate in that run wins, and tombstone drops use that entry's seq.
    #[test]
    fn heap_merge_matches_btree_bytes() {
        fn btree_merge(
            sst_bytes: &[Vec<u8>],
            drop_tombstones: bool,
            target_bytes: usize,
            codec: Codec,
        ) -> (Vec<Vec<u8>>, u64) {
            let mut map: std::collections::BTreeMap<Vec<u8>, Entry> = std::collections::BTreeMap::new();
            for bytes in sst_bytes.iter().rev() {
                for e in decode_sst(bytes).unwrap() {
                    map.insert(e.key().to_vec(), e);
                }
            }
            let mut dropped = 0u64;
            let entries: Vec<Entry> = map
                .into_values()
                .filter(|e| {
                    let drop = drop_tombstones && matches!(e, Entry::Del { .. });
                    if drop {
                        dropped = dropped.max(e.seq());
                    }
                    !drop
                })
                .collect();
            let mut runs = Vec::new();
            let mut start = 0;
            let mut size = 0;
            for (i, e) in entries.iter().enumerate() {
                size += entry_size(e);
                if size >= target_bytes {
                    runs.push(encode_sst(&entries[start..=i], codec));
                    start = i + 1;
                    size = 0;
                }
            }
            if start < entries.len() {
                runs.push(encode_sst(&entries[start..], codec));
            }
            (runs, dropped)
        }

        let mut state = 0xC0FFEE_u64;
        let mut next = || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        for trial in 0..200 {
            let n_runs = (next() % 5) as usize;
            let n_keys = (next() % 16) as usize;
            let blobs: Vec<Vec<u8>> = (0..n_runs)
                .map(|run| {
                    let mut entries = Vec::new();
                    for k in 0..n_keys {
                        if next() % 3 == 0 {
                            continue;
                        }
                        for dup in 0..(next() % 3) + 1 {
                            let key = format!("k{k:02}").into_bytes();
                            let seq = (run as u64) * 10 + dup;
                            if next() % 4 == 0 {
                                entries.push(Entry::Del { key, seq });
                            } else {
                                entries.push(Entry::Put { key, value: vec![run as u8, dup as u8], seq });
                            }
                        }
                    }
                    if next() % 2 == 0 {
                        entries.push(put(b"a", b"prefix", run as u64));
                        entries.push(put(b"ab", b"longer", run as u64));
                    }
                    encode_sst(&entries, Codec::Raw)
                })
                .collect();
            let drop_tombstones = next() % 2 == 0;
            let target = [0usize, 1, 40, 120, usize::MAX][(next() as usize) % 5];
            for codec in [Codec::Raw, Codec::Lz4] {
                let got = merge_sst_bytes(&blobs, drop_tombstones, target, codec).unwrap();
                let want = btree_merge(&blobs, drop_tombstones, target, codec);
                assert_eq!(got.1, want.1, "dropped trial {trial} codec {codec:?}");
                assert_eq!(got.0, want.0, "bytes trial {trial} codec {codec:?}");
            }
        }
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

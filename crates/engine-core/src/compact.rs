//! SST merge for compaction (newest-first inputs).

use crate::sst::{decode_sst, encode_sst, entry_size, Codec, Entry, SstError};
use std::collections::BTreeMap;

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
    let mut map: BTreeMap<Vec<u8>, Entry> = BTreeMap::new();
    for bytes in sst_bytes.iter().rev() {
        for e in decode_sst(bytes)? {
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

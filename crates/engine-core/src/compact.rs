//! SST merge for compaction (newest-first inputs).

use crate::sst::{decode_sst, encode_sst, Entry, SstError};
use std::collections::BTreeMap;

/// Merge SST files. `sst_bytes` is newest-first. Newer entries win.
/// `drop_tombstones` is for a merge that includes the oldest run, where no
/// older value is left for a tombstone to hide.
pub fn merge_sst_bytes(sst_bytes: &[Vec<u8>], drop_tombstones: bool) -> Result<Vec<u8>, SstError> {
    let mut map: BTreeMap<Vec<u8>, Entry> = BTreeMap::new();
    for bytes in sst_bytes.iter().rev() {
        for e in decode_sst(bytes)? {
            map.insert(e.key().to_vec(), e);
        }
    }
    let entries: Vec<Entry> = map
        .into_values()
        .filter(|e| !(drop_tombstones && matches!(e, Entry::Del { .. })))
        .collect();
    Ok(encode_sst(&entries))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put(k: &[u8], v: &[u8]) -> Entry {
        Entry::Put { key: k.to_vec(), value: v.to_vec() }
    }

    #[test]
    fn newer_wins() {
        let older = encode_sst(&[put(b"k", b"old")]);
        let newer = encode_sst(&[put(b"k", b"new")]);
        let out = merge_sst_bytes(&[newer, older], false).unwrap();
        assert_eq!(decode_sst(&out).unwrap(), vec![put(b"k", b"new")]);
    }

    #[test]
    fn bottom_merge_drops_tombstones() {
        let older = encode_sst(&[put(b"a", b"1"), put(b"b", b"1")]);
        let newer = encode_sst(&[Entry::Del { key: b"a".to_vec() }]);
        let kept = merge_sst_bytes(&[newer.clone(), older.clone()], false).unwrap();
        assert_eq!(
            decode_sst(&kept).unwrap(),
            vec![Entry::Del { key: b"a".to_vec() }, put(b"b", b"1")]
        );
        let dropped = merge_sst_bytes(&[newer, older], true).unwrap();
        assert_eq!(decode_sst(&dropped).unwrap(), vec![put(b"b", b"1")]);
    }
}

//! Compaction planning and SST merge (newest-first inputs).

use crate::sst::{decode_sst, encode_sst, Entry, SstError};
use std::collections::BTreeMap;

/// Provisional: compact when this many L0 runs are named in the generation.
pub const L0_COMPACT_THRESHOLD: usize = 4;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompactionPlan {
    /// L0 paths to merge (as listed newest-first in the generation).
    pub inputs: Vec<String>,
    /// Paths to keep untouched (non-L0 runs), newest-first order preserved.
    pub keep: Vec<String>,
}

/// If `runs` (newest-first) has enough `l0/` entries, plan merging all of them.
pub fn plan_l0_compaction(runs: &[String]) -> Option<CompactionPlan> {
    let l0: Vec<String> = runs
        .iter()
        .filter(|p| p.starts_with("l0/"))
        .cloned()
        .collect();
    if l0.len() < L0_COMPACT_THRESHOLD {
        return None;
    }
    let keep: Vec<String> = runs
        .iter()
        .filter(|p| !p.starts_with("l0/"))
        .cloned()
        .collect();
    Some(CompactionPlan { inputs: l0, keep })
}

/// Merge SST files. `sst_bytes` is newest-first (same order as generation L0 list).
/// Newer entries win; tombstones are kept (needed if older levels exist).
pub fn merge_sst_bytes(sst_bytes: &[Vec<u8>]) -> Result<Vec<u8>, SstError> {
    // Apply oldest first so newer overwrites in the map.
    let mut map: BTreeMap<Vec<u8>, Entry> = BTreeMap::new();
    for bytes in sst_bytes.iter().rev() {
        for e in decode_sst(bytes)? {
            let key = e.key().to_vec();
            map.insert(key, e);
        }
    }
    let entries: Vec<Entry> = map.into_values().collect();
    Ok(encode_sst(&entries))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sst::Entry;

    #[test]
    fn newer_wins() {
        let older = encode_sst(&[Entry::Put {
            key: b"k".to_vec(),
            value: b"old".to_vec(),
        }]);
        let newer = encode_sst(&[Entry::Put {
            key: b"k".to_vec(),
            value: b"new".to_vec(),
        }]);
        // newest-first
        let out = merge_sst_bytes(&[newer, older]).unwrap();
        let decoded = decode_sst(&out).unwrap();
        assert_eq!(
            decoded,
            vec![Entry::Put {
                key: b"k".to_vec(),
                value: b"new".to_vec()
            }]
        );
    }

    #[test]
    fn plan_threshold() {
        let runs: Vec<String> = (0..4).map(|i| format!("l0/{i}.sst")).collect();
        assert!(plan_l0_compaction(&runs).is_some());
        assert!(plan_l0_compaction(&runs[..3]).is_none());
    }
}

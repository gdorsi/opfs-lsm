//! Pure LSM helpers for the async OPFS engine. No I/O, no WASM.

mod bloom;
mod compact;
mod crc32;
mod sst;

pub use bloom::{
    bloom_add, bloom_might_contain, bloom_params, create_bloom, BloomFilter,
};
pub use compact::{
    merge_sst_bytes, plan_l0_compaction, CompactionPlan, L0_COMPACT_THRESHOLD,
};
pub use sst::{decode_sst, encode_sst, Entry, SstError};

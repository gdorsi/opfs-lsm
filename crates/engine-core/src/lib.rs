//! Pure LSM helpers for the async OPFS engine. No I/O, no WASM.

#![cfg_attr(not(test), no_std)]
extern crate alloc;

mod bloom;
mod crc32;
mod merge;
mod sst;

pub use bloom::{
    bloom_add, bloom_add_hash, bloom_from_hashes, bloom_might_contain, bloom_params, create_bloom,
    key_hash, BloomFilter,
};
pub use merge::{Demand, MergeConfig, MergeError, MergeSession, Stop};
pub use sst::{
    decode_block, decode_sst, encode_run, encode_run_into, encode_sst, fold_run_into, scan_block_contains, EncodedRun, Entry,
    EntryRef, OutOfOrder, RunEnd, SstError, SstWriter,
};

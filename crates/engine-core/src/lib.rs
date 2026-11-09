//! Pure LSM helpers for the async OPFS engine. No I/O, no WASM.

#![cfg_attr(not(test), no_std)]
extern crate alloc;

mod bloom;
mod compact;
mod crc32;
mod sst;

pub use bloom::{
    bloom_add, bloom_might_contain, bloom_params, create_bloom, BloomFilter,
};
pub use compact::merge_sst_bytes;
pub use sst::{decode_sst, encode_sst, lz4_unpack, scan_block_contains, Codec, Entry, SstError};

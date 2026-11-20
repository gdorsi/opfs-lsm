//! `decode_block` on one arbitrary data block.
#![no_main]

#[path = "../../tests/support/corrupt.rs"]
mod corrupt;

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| corrupt::check_block(data));

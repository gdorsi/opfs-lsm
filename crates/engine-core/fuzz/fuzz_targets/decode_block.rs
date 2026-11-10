//! `decode_block`, the block decoder a merge session reads with, on one
//! arbitrary framed block. Byte 0 bit 0 picks LZ4; the rest is the block.
#![no_main]

#[path = "../../tests/support/corrupt.rs"]
mod corrupt;

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let Some((codec, framed)) = corrupt::block_case(data) else { return };
    corrupt::check_block(framed, codec);
});

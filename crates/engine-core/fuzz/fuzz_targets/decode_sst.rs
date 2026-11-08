//! `decode_sst` on arbitrary bytes. Byte 0 bit 0 rewrites the footer CRC
//! first, so the fuzzer explores the structure behind the check.
#![no_main]

#[path = "../../tests/support/corrupt.rs"]
mod corrupt;

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let Some((&flags, rest)) = data.split_first() else { return };
    let mut buf = rest.to_vec();
    if flags & 1 != 0 {
        corrupt::fix_crc(&mut buf);
    }
    corrupt::check_decode(&buf);
});

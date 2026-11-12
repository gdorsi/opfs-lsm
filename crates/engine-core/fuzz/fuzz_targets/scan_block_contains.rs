//! `scan_block_contains` on one arbitrary framed block, as a tab calls it:
//! no CRC guards it. See `corrupt::scan_case` for the input layout.
#![no_main]

#[path = "../../tests/support/corrupt.rs"]
mod corrupt;

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let Some((codec, pattern, now, framed)) = corrupt::scan_case(data) else { return };
    let patterns: Vec<&[u8]> = if pattern.is_empty() { vec![] } else { vec![&pattern] };
    corrupt::check_scan(framed, codec, &patterns, now);
});

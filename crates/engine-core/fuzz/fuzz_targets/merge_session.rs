//! A merge session over up to eight arbitrary runs grouped into sources, fed
//! in an arbitrary order with arbitrary window sizes. See
//! `corrupt::session_case` for the input layout.
#![no_main]

#[path = "../../tests/support/corrupt.rs"]
mod corrupt;

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let Some((sources, config, seed)) = corrupt::session_case(data) else { return };
    corrupt::check_session(&sources, config, seed);
});

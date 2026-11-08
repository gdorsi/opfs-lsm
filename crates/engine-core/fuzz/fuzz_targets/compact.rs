//! `merge_sst_bytes` (compaction) over up to six arbitrary inputs. See
//! `corrupt::merge_case` for the input layout.
#![no_main]

#[path = "../../tests/support/corrupt.rs"]
mod corrupt;

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let Some((inputs, drop_tombstones, target, codec)) = corrupt::merge_case(data) else { return };
    corrupt::check_merge(&inputs, drop_tombstones, target, codec);
});

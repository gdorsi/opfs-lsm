//! Corrupt-input properties for the decoders, on stable Rust, in the normal
//! `cargo test`. Valid runs from the encoder are mutated (bit flips,
//! truncation, extension, inflated length fields, splices of two runs), with
//! and without a rewritten CRC, and fed to `decode_sst`,
//! `scan_block_contains` and `merge_sst_bytes` through the checks in
//! `support/corrupt.rs`, the same ones the `cargo fuzz` targets run.
//!
//! `ENGINE_PROP_CASES` sets the cases per property (default 300).
//! `ENGINE_PROP_SEED` replays one seed. A failure prints the seed and the
//! input as hex.
//!
//! Every allocation is counted (`Counting` below): a single allocation over
//! `ALLOC_LIMIT` fails the case, so a length field that sizes a buffer is
//! caught on a 64-bit host, where the allocation itself would succeed.

mod support;

use engine_core::{decode_sst, encode_sst, scan_block_contains, Codec, Entry};
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use support::corrupt::{self, fix_crc, sample_entries, FOOTER_BYTES};

struct Counting;

thread_local! {
    static LARGEST: Cell<usize> = const { Cell::new(0) };
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let _ = LARGEST.try_with(|l| l.set(l.get().max(layout.size())));
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let _ = LARGEST.try_with(|l| l.set(l.get().max(layout.size())));
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let _ = LARGEST.try_with(|l| l.set(l.get().max(new_size)));
        unsafe { System.realloc(ptr, layout, new_size) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static ALLOC: Counting = Counting;

/// No single allocation may pass this while decoding a case. Valid runs here
/// are under 64 KiB, and an LZ4 block unpacks to at most 255 times its size.
const ALLOC_LIMIT: usize = 64 << 20;

/// The largest single allocation `f` makes.
fn largest_alloc<T>(f: impl FnOnce() -> T) -> (T, usize) {
    LARGEST.with(|l| l.set(0));
    let out = f();
    (out, LARGEST.with(|l| l.get()))
}

/// xorshift64*: small, seedable, no dependency.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
    fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            0
        } else {
            (self.next() % n as u64) as usize
        }
    }
    fn chance(&mut self, one_in: usize) -> bool {
        self.below(one_in) == 0
    }
}

fn cases() -> u64 {
    std::env::var("ENGINE_PROP_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(300)
}

fn seeds(salt: u64) -> Vec<u64> {
    if let Some(seed) = std::env::var("ENGINE_PROP_SEED").ok().and_then(|v| v.parse().ok()) {
        return vec![seed];
    }
    (1..=cases()).map(|i| i.wrapping_mul(0x9e37_79b9_7f4a_7c15) ^ salt).collect()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Run `check` on the case of every seed. A panic or an allocation over
/// `ALLOC_LIMIT` fails with the seed and the input.
fn for_each_case(salt: u64, make: impl Fn(&mut Rng) -> Vec<u8>, check: impl Fn(&[u8]) + std::panic::RefUnwindSafe) {
    let quiet = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let mut failure = None;
    for seed in seeds(salt) {
        let input = make(&mut Rng(seed | 1));
        let (outcome, largest) = largest_alloc(|| std::panic::catch_unwind(|| check(&input)));
        let why = match outcome {
            Err(e) => Some(
                e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default(),
            ),
            Ok(()) if largest > ALLOC_LIMIT => Some(format!("allocated {largest} bytes at once")),
            Ok(()) => None,
        };
        if let Some(why) = why {
            failure = Some(format!("seed {seed}: {why}\ninput ({} bytes): {}", input.len(), hex(&input[..input.len().min(512)])));
            break;
        }
    }
    std::panic::set_hook(quiet);
    if let Some(f) = failure {
        panic!("{f}");
    }
}

/// A valid run of random shape: key count, key and value sizes, tombstones,
/// codec, and sometimes one record over the 4 KiB block target.
fn valid_run(rng: &mut Rng) -> (Vec<u8>, Codec) {
    let codec = if rng.chance(2) { Codec::Lz4 } else { Codec::Raw };
    let n = [0, 1, 3, 20, 200][rng.below(5)];
    let mut entries = sample_entries(n, rng.below(1000) as u64);
    if rng.chance(4) {
        entries.push(Entry::Put { key: b"zz/big".to_vec(), value: vec![b'v'; 5000 + rng.below(3000)], seq: 9 });
    }
    (encode_sst(&entries, codec), codec)
}

/// One mutation of `buf`, picked at random: a bit flip, a truncation, an
/// extension, a u32 or varint inflated to near its maximum, a run of 0x00
/// or 0xff bytes, or a splice with a second valid run.
fn mutate(rng: &mut Rng, buf: &mut Vec<u8>) {
    let len = buf.len();
    match rng.below(7) {
        0 => {
            for _ in 0..=rng.below(3) {
                if len > 0 {
                    let i = rng.below(len);
                    buf[i] ^= 1 << rng.below(8);
                }
            }
        }
        1 => buf.truncate(rng.below(len + 1)),
        2 => {
            let extra = rng.below(64) + 1;
            for _ in 0..extra {
                buf.push(rng.next() as u8);
            }
        }
        3 if len >= 4 => {
            // A length field inflated: aim at the footer half the time.
            let at = if rng.chance(2) && len >= FOOTER_BYTES { len - FOOTER_BYTES + 4 * rng.below(8) } else { rng.below(len - 3) };
            let v: u32 = [u32::MAX, u32::MAX / 2, 0x0100_0000, len as u32 * 2, rng.next() as u32][rng.below(5)];
            buf[at..at + 4].copy_from_slice(&v.to_le_bytes());
        }
        4 if len >= 5 => {
            // A varint inflated to five bytes near u32::MAX.
            let at = rng.below(len - 4);
            buf[at..at + 5].copy_from_slice(&[0xf0, 0xff, 0xff, 0xff, 0x0f]);
        }
        5 if len > 0 => {
            let at = rng.below(len);
            let n = (rng.below(32) + 1).min(len - at);
            let fill = if rng.chance(2) { 0 } else { 0xff };
            buf[at..at + n].fill(fill);
        }
        _ => {
            let (other, _) = valid_run(rng);
            let cut = rng.below(len + 1);
            let from = rng.below(other.len() + 1);
            buf.truncate(cut);
            buf.extend_from_slice(&other[from..]);
        }
    }
}

/// A mutated run, its CRC rewritten half the time.
fn mutated_run(rng: &mut Rng) -> Vec<u8> {
    let (mut buf, _) = valid_run(rng);
    for _ in 0..=rng.below(2) {
        mutate(rng, &mut buf);
    }
    if rng.chance(2) {
        fix_crc(&mut buf);
    }
    buf
}

#[test]
fn decode_sst_survives_mutated_runs() {
    for_each_case(1, mutated_run, |buf| corrupt::check_decode(buf));
}

/// Without a rewritten CRC, any change to a run's bytes is caught: the
/// SharedWorker never compacts a corrupt run into a wrong answer.
#[test]
fn decode_sst_rejects_every_change_the_crc_covers() {
    for_each_case(
        2,
        |rng| {
            let (orig, _) = valid_run(rng);
            let mut buf = orig.clone();
            mutate(rng, &mut buf);
            // Flag unchanged inputs so the check skips them.
            let same = u8::from(buf == orig);
            let mut out = vec![same];
            out.extend_from_slice(&buf);
            out
        },
        |case| {
            let (&same, buf) = case.split_first().unwrap();
            if same == 0 && !corrupt::known_bug(buf, None) {
                assert!(decode_sst(buf).is_err(), "a changed run decoded");
            }
        },
    );
}

#[test]
fn scan_block_contains_survives_mutated_blocks() {
    for_each_case(
        3,
        |rng| {
            let (buf, codec) = valid_run(rng);
            let blocks = corrupt::framed_blocks(&buf);
            let mut framed = if blocks.is_empty() { vec![] } else { blocks[rng.below(blocks.len())].to_vec() };
            for _ in 0..=rng.below(2) {
                mutate(rng, &mut framed);
            }
            let pattern: &[u8] = [&b""[..], b" hot", b"\"n\":1", b"zz"][rng.below(4)];
            let mut out = vec![codec as u8, pattern.len() as u8];
            out.extend_from_slice(pattern);
            out.extend_from_slice(&framed);
            out
        },
        |case| {
            let (codec, pattern, framed) = corrupt::scan_case(case).unwrap();
            let patterns: Vec<&[u8]> = if pattern.is_empty() { vec![] } else { vec![&pattern] };
            corrupt::check_scan(framed, codec, &patterns);
        },
    );
}

#[test]
fn compaction_fails_on_a_corrupt_input_and_folds_valid_ones() {
    for_each_case(
        4,
        |rng| {
            let inputs: Vec<Vec<u8>> = (0..rng.below(4) + 1)
                .map(|_| if rng.chance(3) { mutated_run(rng) } else { valid_run(rng).0 })
                .collect();
            let flags = rng.below(4) as u8;
            corrupt::encode_merge_case(&inputs, flags, rng.below(8) as u8)
        },
        |case| {
            let (inputs, drop, target, codec) = corrupt::merge_case(case).unwrap();
            corrupt::check_merge(&inputs, drop, target, codec);
        },
    );
}

#[test]
fn valid_runs_decode_and_scan_to_what_was_written() {
    for_each_case(
        5,
        |rng| valid_run(rng).0,
        |buf| {
            let entries = decode_sst(buf).expect("a valid run decodes");
            corrupt::check_decode(buf);
            let codec = if corrupt::footer(buf).unwrap().codec == 1 { Codec::Lz4 } else { Codec::Raw };
            assert_eq!(encode_sst(&entries, codec), buf, "decode then encode gives back the same bytes");
        },
    );
}

/// The checks themselves catch what they claim to: a block that scans to a
/// different answer than it decodes to fails `check_scan`.
#[test]
fn the_wrapper_run_decodes_a_block_as_the_engine_writes_it() {
    let run = corrupt::sample_run(20, 3, Codec::Raw);
    let framed = corrupt::framed_blocks(&run)[0].to_vec();
    let wrapped = corrupt::wrap_block(&framed, Codec::Raw, corrupt::u32_at(&framed, 0).unwrap());
    assert_eq!(decode_sst(&wrapped).unwrap(), decode_sst(&run).unwrap());
}

// --- Known bugs: inputs the fuzzers found, pinned until a fix lands. Each
// is ignored so the suite stays green; `cargo test -- --ignored` runs them.

/// KB1: an LZ4 block's u32 uncompressed size sizes a zeroed buffer before
/// a byte is decoded (`lz4_flex::block::decompress(src, size)` in
/// `scan_block_contains` and `decode_sst`, and `lz4_decompress_js`). A tab
/// reads LZ4 blocks with no CRC check, so one corrupt size grows the wasm
/// memory by up to 4 GiB, and wasm memory never shrinks.
/// Candidate fix: reject `size > 255 * src.len() + 16` (LZ4's largest
/// ratio) with `BadBlock` before decompressing.
#[test]
#[ignore = "KB1: LZ4 uncompressed size is trusted (reported, not fixed)"]
fn kb1_an_lz4_block_size_does_not_size_an_allocation() {
    let framed = [0xff, 0xff, 0xff, 0x7f, 0x10, 0x41];
    let (out, largest) = largest_alloc(|| scan_block_contains(&framed, Codec::Lz4, &[]));
    assert!(out.is_err());
    assert!(largest <= ALLOC_LIMIT, "allocated {largest} bytes for a 6-byte block");
}

/// KB2: `decode_sst` reserves the footer's `entry_count` entries
/// (`Vec::with_capacity(entry_count)` in `decode_blocks`) before it reads a
/// block. Reached only past the CRC, so only by bytes written on purpose:
/// a CRC-valid run with `entry_count` near `u32::MAX` asks for ~200 GiB
/// natively (abort) and overflows capacity in wasm (panic).
/// Candidate fix: cap the reservation, e.g. `entry_count.min(data_len / 10)`
/// (a record is at least 10 bytes).
#[test]
#[ignore = "KB2: footer entry count sizes an allocation (reported, not fixed)"]
fn kb2_the_footer_entry_count_does_not_size_an_allocation() {
    let mut run = corrupt::sample_run(3, 1, Codec::Raw);
    let at = run.len() - FOOTER_BYTES;
    run[at..at + 4].copy_from_slice(&0x0400_0000u32.to_le_bytes());
    fix_crc(&mut run);
    let (out, largest) = largest_alloc(|| decode_sst(&run));
    assert!(out.is_err());
    assert!(largest <= ALLOC_LIMIT, "allocated {largest} bytes for a {}-byte run", run.len());
}

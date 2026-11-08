//! Decoder checks shared by the stable property tests (`tests/corrupt_inputs.rs`)
//! and the `cargo fuzz` targets (`fuzz/fuzz_targets/`). Each `check_*`
//! function runs one engine entry point on arbitrary bytes and panics when
//! the outcome breaks the rules of
//! docs/research/corruption-hardening-test-suite.md ("Decisions"):
//!
//! - every input: no panic, no out-of-bounds read, no unbounded allocation
//!   from a length field, no endless loop;
//! - `decode_sst` checks the CRC, so bytes it accepts are the bytes the
//!   encoder wrote: they decode to entries that a merge or a block scan
//!   agrees with;
//! - `scan_block_contains` checks no CRC (tabs call it): a wrong answer is
//!   allowed, but it must agree with a full decode of the same block when
//!   both succeed, and every hit must hold every pattern.
//!
//! Inputs that hit a known, reported bug are skipped by `known_bug` unless
//! `ENGINE_FUZZ_KNOWN=1`, so a long run keeps finding new bugs.

#![allow(dead_code)]

use engine_core::{decode_sst, encode_sst, merge_sst_bytes, scan_block_contains, Codec, Entry};
use std::collections::BTreeMap;

pub const FOOTER_BYTES: usize = 44;

/// CRC-32 (IEEE), bit by bit. The engine's own is private; this one is slow
/// and obviously right.
pub fn crc32(data: &[u8]) -> u32 {
    let mut c = 0xffff_ffffu32;
    for &b in data {
        c ^= u32::from(b);
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
        }
    }
    !c
}

pub fn u32_at(buf: &[u8], o: usize) -> Option<u32> {
    let end = o.checked_add(4)?;
    Some(u32::from_le_bytes(buf.get(o..end)?.try_into().ok()?))
}

/// Rewrite the footer CRC so the bytes pass the check and the decoder
/// reaches the structure behind it. No-op on a buffer too short for a footer.
pub fn fix_crc(buf: &mut [u8]) {
    if buf.len() < FOOTER_BYTES {
        return;
    }
    let at = buf.len() - 12;
    let sum = crc32(&buf[..at]);
    buf[at..at + 4].copy_from_slice(&sum.to_le_bytes());
}

/// The footer fields, read without trusting them.
#[derive(Debug, Clone, Copy)]
pub struct Footer {
    pub entry_count: u32,
    pub block_count: u32,
    pub data_len: u32,
    pub index_start: u32,
    pub index_end: usize,
    pub codec: u32,
}

pub fn footer(buf: &[u8]) -> Option<Footer> {
    if buf.len() < FOOTER_BYTES {
        return None;
    }
    let at = buf.len() - FOOTER_BYTES;
    let f = |i: usize| u32_at(buf, at + 4 * i).unwrap();
    Some(Footer { entry_count: f(0), block_count: f(1), data_len: f(2), index_start: f(5), index_end: at, codec: f(7) })
}

/// The framed bytes of every data block the index names, as a tab would
/// slice them. Bounded: stops at the first entry that does not fit.
pub fn framed_blocks(buf: &[u8]) -> Vec<&[u8]> {
    let Some(f) = footer(buf) else { return vec![] };
    let mut out = Vec::new();
    let mut o = f.index_start as usize;
    for _ in 0..f.block_count.min(4096) {
        let Some(first) = u32_at(buf, o) else { break };
        o = o.saturating_add(4).saturating_add(first as usize);
        let Some(last) = u32_at(buf, o) else { break };
        o = o.saturating_add(4).saturating_add(last as usize);
        let (Some(offset), Some(length)) = (u32_at(buf, o), u32_at(buf, o.saturating_add(4))) else { break };
        o = o.saturating_add(8);
        let (start, len) = (offset as usize, length as usize);
        match buf.get(start..start.saturating_add(len)) {
            Some(b) if start.saturating_add(len) <= f.data_len as usize => out.push(b),
            _ => break,
        }
    }
    out
}

/// Inputs that reach a bug already reported and pinned by an ignored test in
/// `tests/corrupt_inputs.rs`. Fuzzing skips them so it keeps looking for new ones.
/// Each clause names its bug.
pub fn known_bug(buf: &[u8], codec_hint: Option<Codec>) -> bool {
    if known_bugs_included() {
        return false;
    }
    // KB1: an LZ4 block's u32 uncompressed size is allocated before the
    // block is decoded (`lz4_flex::block::decompress`), up to 4 GiB.
    let lz4_size_unbounded = |framed: &[u8]| -> bool {
        match u32_at(framed, 0) {
            Some(size) => size as usize > 255 * framed.len() + 64,
            None => false,
        }
    };
    if let Some(codec) = codec_hint {
        return codec == Codec::Lz4 && lz4_size_unbounded(buf);
    }
    let Some(f) = footer(buf) else { return false };
    // KB2: `decode_sst` reserves `entry_count` entries from the footer
    // before reading a block (`Vec::with_capacity(entry_count)`).
    if f.entry_count as usize > buf.len() {
        return true;
    }
    f.codec == 1 && framed_blocks(buf).into_iter().any(lz4_size_unbounded)
}

fn known_bugs_included() -> bool {
    use std::sync::OnceLock;
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| std::env::var("ENGINE_FUZZ_KNOWN").is_ok_and(|v| v == "1"))
}

/// `decode_sst` on arbitrary bytes. When it succeeds, the entries round-trip
/// through the encoder, and a block scan of every block agrees with them.
pub fn check_decode(buf: &[u8]) {
    if known_bug(buf, None) {
        return;
    }
    let Ok(entries) = decode_sst(buf) else { return };
    let f = footer(buf).expect("a decoded run has a footer");
    assert_eq!(entries.len(), f.entry_count as usize, "decode returned the footer's entry count");
    let codec = if f.codec == 1 { Codec::Lz4 } else { Codec::Raw };
    let mut hits = Vec::new();
    for framed in framed_blocks(buf) {
        let packed = scan_block_contains(framed, codec, &[]).expect("a block of a run that decodes must scan");
        hits.extend(unpack_hits(&packed));
    }
    let puts: Vec<(Vec<u8>, Vec<u8>)> = entries
        .iter()
        .filter_map(|e| match e {
            Entry::Put { key, value, .. } => Some((key.clone(), value.clone())),
            Entry::Del { .. } => None,
        })
        .collect();
    assert_eq!(hits, puts, "an unfiltered scan returns every put of a decoded run, in file order");
}

/// Parse `u32 key_len, u32 value_len, key, value` hits. Panics when the
/// engine returned hits that do not parse.
pub fn unpack_hits(packed: &[u8]) -> Vec<(Vec<u8>, Vec<u8>)> {
    let mut out = Vec::new();
    let mut o = 0;
    while o < packed.len() {
        let k = u32_at(packed, o).expect("hit header") as usize;
        let v = u32_at(packed, o + 4).expect("hit header") as usize;
        o += 8;
        let key = packed.get(o..o + k).expect("hit key in bounds").to_vec();
        let value = packed.get(o + k..o + k + v).expect("hit value in bounds").to_vec();
        out.push((key, value));
        o += k + v;
    }
    out
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    needle.is_empty() || hay.windows(needle.len()).any(|w| w == needle)
}

/// `scan_block_contains` on arbitrary framed bytes. Every hit holds every
/// pattern. When the scan succeeds, the same block wrapped in a one-block
/// run decodes, and its puts filtered by the patterns are the hits.
pub fn check_scan(framed: &[u8], codec: Codec, patterns: &[&[u8]]) {
    if known_bug(framed, Some(codec)) {
        return;
    }
    let Ok(packed) = scan_block_contains(framed, codec, patterns) else { return };
    let hits = unpack_hits(&packed);
    for (_, value) in &hits {
        assert!(patterns.iter().all(|p| contains(value, p)), "a hit holds every pattern");
    }
    let Some(count) = record_count(framed, codec) else { return };
    let run = wrap_block(framed, codec, count);
    let entries = decode_sst(&run).expect("a block that scans decodes as a one-block run");
    let want: Vec<(Vec<u8>, Vec<u8>)> = entries
        .into_iter()
        .filter_map(|e| match e {
            Entry::Put { key, value, .. } if patterns.iter().all(|p| contains(&value, p)) => Some((key, value)),
            _ => None,
        })
        .collect();
    assert_eq!(hits, want, "scan and decode agree on one block");
}

fn record_count(framed: &[u8], codec: Codec) -> Option<u32> {
    match codec {
        Codec::Raw => u32_at(framed, 0),
        Codec::Lz4 => {
            let size = u32_at(framed, 0)? as usize;
            let block = lz4_flex::block::decompress(framed.get(4..)?, size).ok()?;
            u32_at(&block, 0)
        }
    }
}

/// A run holding exactly one data block, `framed`, with no bloom bits and a
/// valid footer and CRC.
pub fn wrap_block(framed: &[u8], codec: Codec, count: u32) -> Vec<u8> {
    let mut out = framed.to_vec();
    let data_len = out.len() as u32;
    let index_start = out.len() as u32;
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&data_len.to_le_bytes());
    let index_len = out.len() as u32 - index_start;
    for v in [count, 1, data_len, 0, 1, index_start, index_len, codec as u32] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    let sum = crc32(&out);
    out.extend_from_slice(&sum.to_le_bytes());
    out.extend_from_slice(&1u32.to_le_bytes());
    out.extend_from_slice(&0x4f4c_5354u32.to_le_bytes());
    out
}

/// `merge_sst_bytes` on arbitrary inputs, newest first. A merge must fail
/// when any input fails to decode, so a corrupt run is never compacted away.
/// When every input decodes with sorted keys, the output must equal a
/// `BTreeMap` fold of the inputs (newest wins, the last duplicate in a run
/// wins), cut into runs that each decode.
pub fn check_merge(inputs: &[Vec<u8>], drop_tombstones: bool, target_bytes: usize, codec: Codec) {
    if inputs.iter().any(|b| known_bug(b, None)) {
        return;
    }
    let result = merge_sst_bytes(inputs, drop_tombstones, target_bytes, codec);
    let decoded: Result<Vec<Vec<Entry>>, _> = inputs.iter().map(|b| decode_sst(b)).collect();
    let Ok(decoded) = decoded else {
        assert!(result.is_err(), "a merge over an input that does not decode must fail");
        return;
    };
    let (runs, dropped) = result.expect("a merge over inputs that decode must succeed");
    let mut out = Vec::new();
    for run in &runs {
        out.extend(decode_sst(run).expect("merge output decodes"));
    }
    if !decoded.iter().all(|run| run.windows(2).all(|w| w[0].key() <= w[1].key())) {
        return;
    }
    let mut map: BTreeMap<Vec<u8>, Entry> = BTreeMap::new();
    for run in decoded.iter().rev() {
        for e in run {
            map.insert(e.key().to_vec(), e.clone());
        }
    }
    let mut want_dropped = 0;
    let want: Vec<Entry> = map
        .into_values()
        .filter(|e| match e {
            Entry::Del { seq, .. } if drop_tombstones => {
                want_dropped = want_dropped.max(*seq);
                false
            }
            _ => true,
        })
        .collect();
    assert_eq!(out, want, "merge equals the newest-wins fold");
    assert_eq!(dropped, want_dropped, "merge reports the highest dropped tombstone");
}

/// Split fuzz bytes into a merge call: byte 0 holds the flags, then each
/// input is a u16 length and that many bytes. Bit 0 drops tombstones, bit 1
/// writes LZ4, bit 2 fixes each input's CRC; byte 1 picks the target size.
pub fn merge_case(data: &[u8]) -> Option<(Vec<Vec<u8>>, bool, usize, Codec)> {
    let (&flags, rest) = data.split_first()?;
    let (&target, mut rest) = rest.split_first()?;
    let mut inputs = Vec::new();
    while rest.len() >= 2 && inputs.len() < 6 {
        let n = u16::from_le_bytes([rest[0], rest[1]]) as usize;
        rest = &rest[2..];
        let take = n.min(rest.len());
        let mut input = rest[..take].to_vec();
        if flags & 4 != 0 {
            fix_crc(&mut input);
        }
        inputs.push(input);
        rest = &rest[take..];
    }
    let codec = if flags & 2 != 0 { Codec::Lz4 } else { Codec::Raw };
    let target_bytes = if target == 0 { usize::MAX } else { 64 * target as usize };
    Some((inputs, flags & 1 != 0, target_bytes, codec))
}

/// The inverse of `merge_case`, for seeding the corpus.
pub fn encode_merge_case(inputs: &[Vec<u8>], flags: u8, target: u8) -> Vec<u8> {
    let mut out = vec![flags, target];
    for input in inputs {
        out.extend_from_slice(&(input.len() as u16).to_le_bytes());
        out.extend_from_slice(input);
    }
    out
}

/// Split fuzz bytes into a scan call: byte 0 bit 0 picks LZ4, byte 1 is the
/// length of one pattern (0 for none, at most 8), then the pattern, then
/// the framed block.
pub fn scan_case(data: &[u8]) -> Option<(Codec, Vec<u8>, &[u8])> {
    let (&flags, rest) = data.split_first()?;
    let (&n, rest) = rest.split_first()?;
    let n = (n as usize % 9).min(rest.len());
    let codec = if flags & 1 != 0 { Codec::Lz4 } else { Codec::Raw };
    Some((codec, rest[..n].to_vec(), &rest[n..]))
}

/// Entries for seeding: `n` keys under a shared prefix, some tombstones,
/// values that hold " hot" or " cold".
pub fn sample_entries(n: u64, seed: u64) -> Vec<Entry> {
    (0..n)
        .map(|i| {
            let key = format!("t/{:06}", i * 7 + seed).into_bytes();
            if (i + seed) % 5 == 0 {
                Entry::Del { key, seq: i + 1 }
            } else {
                let value = format!("{{\"n\":{i},\"tag\":\"{}\"}}", if i % 3 == 0 { " hot" } else { " cold" }).into_bytes();
                Entry::Put { key, value, seq: i + 1 }
            }
        })
        .collect()
}

pub fn sample_run(n: u64, seed: u64, codec: Codec) -> Vec<u8> {
    encode_sst(&sample_entries(n, seed), codec)
}

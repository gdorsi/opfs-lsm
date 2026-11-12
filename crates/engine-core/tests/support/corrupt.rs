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
//!   both succeed, and every hit must hold every pattern;
//! - a merge session checks every run's CRC before it finishes, so it never
//!   finishes over a run `decode_sst` refuses.

#![allow(dead_code)]

use engine_core::{
    decode_block, decode_sst, encode_sst, scan_block_contains, Codec, EncodedRun, Entry, Marks, MergeConfig,
    MergeError, MergeSession, Stop,
};
use std::collections::BTreeMap;

pub const FOOTER_BYTES: usize = 52;

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
    Some(Footer { entry_count: f(0), block_count: f(1), data_len: f(2), index_start: f(5), index_end: f(8) as usize, codec: f(7) })
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

/// `decode_sst` on arbitrary bytes. When it succeeds, the entries round-trip
/// through the encoder, and a block scan of every block agrees with them.
pub fn check_decode(buf: &[u8]) {
    let Ok(entries) = decode_sst(buf) else { return };
    let f = footer(buf).expect("a decoded run has a footer");
    assert_eq!(entries.len(), f.entry_count as usize, "decode returned the footer's entry count");
    let codec = if f.codec == 1 { Codec::Lz4 } else { Codec::Raw };
    let mut hits = Vec::new();
    for framed in framed_blocks(buf) {
        let packed = scan_block_contains(framed, codec, &[], 0, Marks::NONE).expect("a block of a run that decodes must scan");
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
/// run decodes, and its puts not expired at `now` and filtered by the
/// patterns are the hits.
pub fn check_scan(framed: &[u8], codec: Codec, patterns: &[&[u8]], now: u64) {
    let Ok(packed) = scan_block_contains(framed, codec, patterns, now, Marks::NONE) else { return };
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
            Entry::Put { key, value, expires_at, .. }
                if expires_at.is_none_or(|at| at > now) && patterns.iter().all(|p| contains(&value, p)) =>
            {
                Some((key, value))
            }
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
    let stats_start = out.len() as u32;
    for v in [count, 1, data_len, 0, 1, index_start, index_len, codec as u32, stats_start, 0] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    let sum = crc32(&out);
    out.extend_from_slice(&sum.to_le_bytes());
    out.extend_from_slice(&3u32.to_le_bytes());
    out.extend_from_slice(&0x4f4c_5354u32.to_le_bytes());
    out
}

/// True when the index's blocks follow each other from offset 0 to the end
/// of the data, as `SstWriter` writes them. A merge session reads blocks
/// back to back and refuses any other layout, which `decode_sst` accepts.
pub fn blocks_tile(buf: &[u8]) -> bool {
    let Some(f) = footer(buf) else { return false };
    let mut o = f.index_start as usize;
    let mut next = 0usize;
    for _ in 0..f.block_count {
        let Some(first) = u32_at(buf, o) else { return false };
        o = o.saturating_add(4).saturating_add(first as usize);
        let Some(last) = u32_at(buf, o) else { return false };
        o = o.saturating_add(4).saturating_add(last as usize);
        let (Some(offset), Some(length)) = (u32_at(buf, o), u32_at(buf, o.saturating_add(4))) else { return false };
        o = o.saturating_add(8);
        if offset as usize != next {
            return false;
        }
        next = next.saturating_add(length as usize);
    }
    next == f.data_len as usize
}

/// Drive a merge session over `sources` (each a list of runs, newest source
/// first) to its end, feeding each `Need` in an order picked by `seed`.
pub fn drive_session(sources: &[Vec<Vec<u8>>], config: MergeConfig, seed: u64) -> Result<(Vec<EncodedRun>, u64), MergeError> {
    let sizes: Vec<Vec<u32>> = sources.iter().map(|runs| runs.iter().map(|r| r.len() as u32).collect()).collect();
    let mut session = MergeSession::open(config, &sizes, Marks::NONE)?;
    let mut state = seed | 1;
    let (mut runs, mut bytes) = (Vec::new(), Vec::new());
    loop {
        match session.pump()? {
            Stop::Need(demands) => {
                let mut demands = demands.to_vec();
                for i in (1..demands.len()).rev() {
                    state ^= state << 13;
                    state ^= state >> 7;
                    state ^= state << 17;
                    demands.swap(i, (state % (i as u64 + 1)) as usize);
                }
                for d in demands {
                    let run = &sources[d.source as usize][d.run as usize];
                    let bytes = run.get(d.offset as usize..).and_then(|b| b.get(..d.len as usize)).expect("a demand lies inside its run");
                    session.feed(d.source as usize, bytes.len()).expect("a listed demand takes its bytes").copy_from_slice(bytes);
                }
            }
            Stop::Write(b) => bytes.extend_from_slice(b),
            Stop::RunEnd(end) => runs.push(EncodedRun { bytes: std::mem::take(&mut bytes), end: end.clone() }),
            Stop::Yield => {}
            Stop::Done(dropped) => {
                assert!(bytes.is_empty(), "every written byte belongs to a finished run");
                return Ok((runs, dropped));
            }
        }
    }
}

/// A merge session on arbitrary runs. It must not finish when any run fails
/// to decode, so a corrupt run is never compacted away. When every run
/// decodes, tiles its data and every source is in key order, it must
/// finish. When it finishes, its output is the fold of the decoded sources
/// (newest source wins, the last duplicate in a source wins), cut into runs
/// that each decode to what their `RunEnd` says.
pub fn check_session(sources: &[Vec<Vec<u8>>], config: MergeConfig, seed: u64) {
    let outcome = drive_session(sources, config, seed);
    let decoded: Option<Vec<Vec<Entry>>> = sources
        .iter()
        .map(|runs| {
            let mut all = Vec::new();
            for run in runs {
                all.extend(decode_sst(run).ok()?);
            }
            Some(all)
        })
        .collect();
    let Some(decoded) = decoded else {
        assert!(outcome.is_err(), "a session over a run that does not decode must not finish");
        return;
    };
    let sorted = decoded.iter().all(|s| s.windows(2).all(|w| w[0].key() <= w[1].key()));
    let tiled = sources.iter().flatten().all(|run| blocks_tile(run));
    let (runs, dropped) = match outcome {
        Ok(ok) => ok,
        Err(e) => {
            assert!(!(sorted && tiled), "a session over runs that decode, tile and keep key order must finish: {e:?}");
            assert!(matches!(e, MergeError::Corrupt(_)), "a refused input is corrupt: {e:?}");
            return;
        }
    };
    assert!(sorted, "a finished session read every source in key order");
    let mut out = Vec::new();
    for run in &runs {
        let entries = decode_sst(&run.bytes).expect("session output decodes");
        assert_eq!(run.end.size, run.bytes.len(), "the reported size is the run's size");
        assert_eq!(run.end.entries, entries.len(), "the reported entry count is the run's");
        assert_eq!(run.end.first_key, entries.first().map_or(&[][..], |e| e.key()), "the reported first key");
        assert_eq!(run.end.last_key, entries.last().map_or(&[][..], |e| e.key()), "the reported last key");
        out.extend(entries);
    }
    let mut map: BTreeMap<Vec<u8>, Entry> = BTreeMap::new();
    for source in decoded.iter().rev() {
        for e in source {
            let e = match e.clone() {
                Entry::Put { key, seq, expires_at: Some(at), .. } if at <= config.judge_now => Entry::Del { key, seq },
                other => other,
            };
            map.insert(e.key().to_vec(), e);
        }
    }
    let mut want_dropped = 0;
    let want: Vec<Entry> = map
        .into_values()
        .filter(|e| match e {
            Entry::Del { seq, .. } if config.drop_tombstones => {
                want_dropped = want_dropped.max(*seq);
                false
            }
            _ => true,
        })
        .collect();
    assert_eq!(out, want, "the session's output is the newest-wins fold");
    assert_eq!(dropped, want_dropped, "the session reports the highest dropped tombstone");
}

/// Split fuzz bytes into a session: five header bytes, then each run as a
/// u16 length and that many bytes, at most 8 runs. Byte 0: bit 0 drops
/// tombstones, bit 1 writes LZ4, bit 2 fixes each run's CRC, bit 3 yields
/// after every block, bits 4 to 7 are the expiry judge time. Byte 1 picks the target size (0 for none). Byte 2: bit
/// `i` puts run `i + 1` in the same source as run `i`. Byte 3 picks the
/// chunk (low nibble) and tail (high nibble) sizes. Byte 4 seeds the feed
/// order.
pub fn session_case(data: &[u8]) -> Option<(Vec<Vec<Vec<u8>>>, MergeConfig, u64)> {
    let (head, mut rest) = data.split_at_checked(5)?;
    let [flags, target, group, sizes, seed] = <[u8; 5]>::try_from(head).ok()?;
    let mut sources: Vec<Vec<Vec<u8>>> = Vec::new();
    let mut i = 0;
    while rest.len() >= 2 && i < 8 {
        let n = u16::from_le_bytes([rest[0], rest[1]]) as usize;
        rest = &rest[2..];
        let take = n.min(rest.len());
        let mut run = rest[..take].to_vec();
        if flags & 4 != 0 {
            fix_crc(&mut run);
        }
        rest = &rest[take..];
        match sources.last_mut() {
            Some(source) if i > 0 && group & (1 << (i - 1)) != 0 => source.push(run),
            _ => sources.push(vec![run]),
        }
        i += 1;
    }
    let config = MergeConfig {
        drop_tombstones: flags & 1 != 0,
        judge_now: u64::from(flags >> 4),
        target_bytes: if target == 0 { usize::MAX } else { 64 * target as usize },
        codec: if flags & 2 != 0 { Codec::Lz4 } else { Codec::Raw },
        chunk_bytes: [1, 37, 64, 512, 4096, 65536][(sizes & 0x0f) as usize % 6],
        tail_bytes: [44, 45, 64, 100, 512, 4096, 131_072][(sizes >> 4) as usize % 7],
        yield_bytes: if flags & 8 != 0 { 1 } else { usize::MAX },
    };
    Some((sources, config, u64::from(seed)))
}

/// The inverse of `session_case`, for seeding the corpus.
pub fn encode_session_case(sources: &[Vec<Vec<u8>>], flags: u8, target: u8, sizes: u8, seed: u8) -> Vec<u8> {
    let mut group = 0u8;
    let mut i = 0;
    for source in sources {
        for j in 0..source.len() {
            if j > 0 {
                group |= 1 << (i - 1);
            }
            i += 1;
        }
    }
    assert!(i <= 8, "at most 8 runs");
    let mut out = vec![flags, target, group, sizes, seed];
    for run in sources.iter().flatten() {
        out.extend_from_slice(&(run.len() as u16).to_le_bytes());
        out.extend_from_slice(run);
    }
    out
}

/// `decode_block`, the session's block path, on arbitrary framed bytes. It
/// must agree with `decode_sst` on the same block wrapped in a one-block run
/// and with an unfiltered `scan_block_contains`: all three decode it, or all
/// three refuse it.
pub fn check_block(framed: &[u8], codec: Codec) {
    match decode_block(framed, codec) {
        Ok(entries) => {
            let run = wrap_block(framed, codec, entries.len() as u32);
            assert_eq!(decode_sst(&run).expect("a block that decodes alone decodes in a run"), entries);
            let packed = scan_block_contains(framed, codec, &[], 0, Marks::NONE).expect("a block that decodes scans");
            let puts: Vec<(Vec<u8>, Vec<u8>)> = entries
                .into_iter()
                .filter_map(|e| match e {
                    Entry::Put { key, value, .. } => Some((key, value)),
                    Entry::Del { .. } => None,
                })
                .collect();
            assert_eq!(unpack_hits(&packed), puts, "a scan returns the block's puts");
        }
        Err(_) => {
            // Records are read before the count is checked, so any count does.
            assert!(decode_sst(&wrap_block(framed, codec, 0)).is_err(), "a block refused alone is refused in a run");
            assert!(scan_block_contains(framed, codec, &[], 0, Marks::NONE).is_err(), "a block refused alone is refused by a scan");
        }
    }
}

/// Split fuzz bytes into a block: byte 0 bit 0 picks LZ4, the rest is the
/// framed block.
pub fn block_case(data: &[u8]) -> Option<(Codec, &[u8])> {
    let (&flags, framed) = data.split_first()?;
    Some((if flags & 1 != 0 { Codec::Lz4 } else { Codec::Raw }, framed))
}

/// Split fuzz bytes into a scan call: byte 0 bit 0 picks LZ4 and bits 1 to
/// 7 are the expiry judge time, byte 1 is the length of one pattern (0 for
/// none, at most 8), then the pattern, then the framed block.
pub fn scan_case(data: &[u8]) -> Option<(Codec, Vec<u8>, u64, &[u8])> {
    let (&flags, rest) = data.split_first()?;
    let (&n, rest) = rest.split_first()?;
    let n = (n as usize % 9).min(rest.len());
    let codec = if flags & 1 != 0 { Codec::Lz4 } else { Codec::Raw };
    Some((codec, rest[..n].to_vec(), u64::from(flags >> 1), &rest[n..]))
}

/// Entries for seeding: `n` keys under a shared prefix, some tombstones,
/// some puts with an expiry, values that hold " hot" or " cold".
pub fn sample_entries(n: u64, seed: u64) -> Vec<Entry> {
    (0..n)
        .map(|i| {
            let key = format!("t/{:06}", i * 7 + seed).into_bytes();
            if (i + seed) % 5 == 0 {
                Entry::Del { key, seq: i + 1 }
            } else {
                let value = format!("{{\"n\":{i},\"tag\":\"{}\"}}", if i % 3 == 0 { " hot" } else { " cold" }).into_bytes();
                let expires_at = if i % 4 == 1 { Some(i + 1) } else { None };
                Entry::Put { key, value, seq: i + 1, expires_at }
            }
        })
        .collect()
}

pub fn sample_run(n: u64, seed: u64, codec: Codec) -> Vec<u8> {
    encode_sst(&sample_entries(n, seed), codec)
}

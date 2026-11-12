//! The session against the whole-buffer oracle in `oracle.rs`: for the same
//! sources, the same output bytes and the same dropped seq, however the host
//! answers (chunk and tail sizes, feed order, early pumps, yields).

use super::*;
use crate::sst::{decode_sst, encode_sst, EncodedRun};

/// xorshift64*: small, seedable, no dependency.
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Rng {
        Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1)
    }
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
    fn pick<T: Copy>(&mut self, from: &[T]) -> T {
        from[self.below(from.len())]
    }
    fn bytes(&mut self, len: usize) -> Vec<u8> {
        (0..len).map(|_| self.next() as u8).collect()
    }
}

fn env(name: &str, default: u64) -> u64 {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn put(key: &[u8], value: &[u8], seq: u64) -> Entry {
    Entry::Put { key: key.to_vec(), value: value.to_vec(), seq, expires_at: None }
}

fn put_until(key: &[u8], value: &[u8], seq: u64, expires_at: u64) -> Entry {
    Entry::Put { key: key.to_vec(), value: value.to_vec(), seq, expires_at: Some(expires_at) }
}

fn del(key: &[u8], seq: u64) -> Entry {
    Entry::Del { key: key.to_vec(), seq }
}

/// How the test host answers.
struct Host {
    rng: Rng,
    /// One pump in this many `Need`s comes before every demand is fed.
    early: usize,
}

fn feed(session: &mut MergeSession, sources: &[Vec<Vec<u8>>], d: &Demand) {
    let run = &sources[d.source as usize][d.run as usize];
    let (at, len) = (d.offset as usize, d.len as usize);
    let into = session.feed(d.source as usize, len).expect("a listed demand takes its bytes");
    into.copy_from_slice(&run[at..at + len]);
}

/// Drive a session over `sources` (each a list of run bytes) to the end.
fn drive(config: MergeConfig, sources: &[Vec<Vec<u8>>], host: &mut Host) -> Result<(Vec<EncodedRun>, u64), MergeError> {
    let sizes: Vec<Vec<u32>> = sources.iter().map(|runs| runs.iter().map(|r| r.len() as u32).collect()).collect();
    let mut session = MergeSession::open(config, &sizes)?;
    let (mut runs, mut bytes) = (Vec::new(), Vec::new());
    for _ in 0..50_000_000u64 {
        match session.pump()? {
            Stop::Need(demands) => {
                let mut demands = demands.to_vec();
                assert!(!demands.is_empty());
                for i in (1..demands.len()).rev() {
                    demands.swap(i, host.rng.below(i + 1));
                }
                let early = if host.rng.chance(host.early) { host.rng.below(demands.len()) } else { demands.len() };
                for d in &demands[..early] {
                    feed(&mut session, sources, d);
                }
                if early < demands.len() {
                    assert_eq!(session.pump(), Err(MergeError::Unfed));
                    for d in &demands[early..] {
                        feed(&mut session, sources, d);
                    }
                }
            }
            Stop::Write(b) => {
                assert!(!b.is_empty());
                bytes.extend_from_slice(b);
            }
            Stop::RunEnd(end) => runs.push(EncodedRun { bytes: mem::take(&mut bytes), end: end.clone() }),
            Stop::Yield => {}
            Stop::Done(dropped) => {
                assert!(bytes.is_empty(), "every written byte belongs to a finished run");
                assert_eq!(session.pump(), Ok(Stop::Done(dropped)), "Done is final");
                return Ok((runs, dropped));
            }
        }
    }
    panic!("the session did not finish");
}

fn config(drop_tombstones: bool, target_bytes: usize, codec: Codec) -> MergeConfig {
    MergeConfig {
        drop_tombstones,
        judge_now: 0,
        target_bytes,
        codec,
        chunk_bytes: 256 * 1024,
        tail_bytes: 128 * 1024,
        yield_bytes: 1024 * 1024,
    }
}

fn host(seed: u64) -> Host {
    Host { rng: Rng::new(seed), early: 4 }
}

/// Merge sources of one run each.
fn merge(runs: &[Vec<u8>], drop_tombstones: bool, target_bytes: usize, codec: Codec) -> Result<(Vec<EncodedRun>, u64), MergeError> {
    let sources: Vec<Vec<Vec<u8>>> = runs.iter().map(|r| vec![r.clone()]).collect();
    drive(config(drop_tombstones, target_bytes, codec), &sources, &mut host(1))
}

/// Every output run's entries, after checking that what `RunEnd` reported is
/// what the run holds.
fn entries(runs: &[EncodedRun]) -> Vec<Entry> {
    let mut all = Vec::new();
    for run in runs {
        let entries = decode_sst(&run.bytes).unwrap();
        assert_eq!(run.end.size, run.bytes.len());
        assert_eq!(run.end.entries, entries.len());
        assert_eq!(run.end.first_key, entries.first().unwrap().key());
        assert_eq!(run.end.last_key, entries.last().unwrap().key());
        all.extend(entries);
    }
    all
}

/// The oracle's input for a source: its runs' entries as one run.
fn as_one_run(runs: &[Vec<u8>]) -> Vec<u8> {
    let all: Vec<Entry> = runs.iter().flat_map(|r| decode_sst(r).unwrap()).collect();
    encode_sst(&all, Codec::Raw)
}

fn assert_matches_oracle(cfg: MergeConfig, sources: &[Vec<Vec<u8>>], host: &mut Host, context: &str) {
    let inputs: Vec<Vec<u8>> = sources.iter().map(|runs| as_one_run(runs)).collect();
    let (want, want_dropped) =
        oracle::merge_sst_bytes(&inputs, cfg.drop_tombstones, cfg.judge_now, cfg.target_bytes, cfg.codec).unwrap();
    let (got, dropped) = drive(cfg, sources, host).unwrap_or_else(|e| panic!("{context}: {e:?}"));
    assert_eq!(dropped, want_dropped, "{context}: dropped seq");
    assert_eq!(got.len(), want.len(), "{context}: output runs");
    for (i, (g, w)) in got.iter().zip(&want).enumerate() {
        assert_eq!(g.end, w.end, "{context}: run {i} end");
        assert!(g.bytes == w.bytes, "{context}: run {i} bytes differ ({} vs {} bytes)", g.bytes.len(), w.bytes.len());
    }
}

/// One source's entries in key order. Few distinct keys, so sources overlap
/// and a key repeats within a source, often across a block boundary.
fn source_entries(rng: &mut Rng, keys: usize) -> Vec<Entry> {
    let n = rng.pick(&[0, 1, 2, 5, 20, 80, 300]);
    let big = rng.pick(&[0usize, 0, 1_500, 5_000]);
    let mut out: Vec<Entry> = (0..n)
        .map(|_| {
            let key = format!("k{:04}", rng.below(keys)).into_bytes();
            let seq = rng.next() >> rng.below(64);
            if rng.chance(5) {
                return Entry::Del { key, seq };
            }
            let len = match rng.below(60) {
                0 => 70_000,
                1 if rng.chance(4) => 300_000,
                2..=9 => big,
                _ => rng.below(40),
            };
            let expires_at = if rng.chance(3) { Some(1 + rng.below(30) as u64) } else { None };
            Entry::Put { key, value: rng.bytes(len), seq, expires_at }
        })
        .collect();
    out.sort_by(|a, b| a.key().cmp(b.key()));
    out
}

/// Split a source's entries into runs at random points, which may fall
/// between two equal keys or leave a run empty.
fn split_runs(rng: &mut Rng, entries: &[Entry]) -> Vec<Vec<u8>> {
    let pieces = rng.pick(&[1, 1, 2, 3]);
    let mut cuts: Vec<usize> = (1..pieces).map(|_| rng.below(entries.len() + 1)).collect();
    cuts.sort();
    let mut runs = Vec::new();
    let mut from = 0;
    for to in cuts.into_iter().chain([entries.len()]) {
        let codec = if rng.chance(2) { Codec::Raw } else { Codec::Lz4 };
        runs.push(encode_sst(&entries[from..to], codec));
        from = to;
    }
    runs
}

fn random_config(rng: &mut Rng) -> MergeConfig {
    MergeConfig {
        drop_tombstones: rng.chance(2),
        judge_now: rng.pick(&[0, 1, 10, 20, u64::MAX]),
        target_bytes: rng.pick(&[0, 1, 40, 120, 1_000, 64 * 1024, usize::MAX]),
        codec: if rng.chance(2) { Codec::Raw } else { Codec::Lz4 },
        chunk_bytes: rng.pick(&[0, 1, 37, 512, 4096, 64 * 1024, 256 * 1024]),
        tail_bytes: rng.pick(&[0, 44, 45, 100, 1_000, 4096, 128 * 1024]),
        yield_bytes: rng.pick(&[0, 1, 1_000, usize::MAX]),
    }
}

fn random_sources(rng: &mut Rng) -> Vec<Vec<Vec<u8>>> {
    let keys = rng.pick(&[1, 3, 30, 400]);
    let n = rng.pick(&[0, 1, 2, 3, 5, 8]);
    (0..n)
        .map(|_| {
            let entries = source_entries(rng, keys);
            split_runs(rng, &entries)
        })
        .collect()
}

#[test]
fn random_sources_merge_to_the_oracle_bytes() {
    let cases = env("ENGINE_PROP_CASES", 300);
    let seed = env("ENGINE_PROP_SEED", 1);
    for case in seed..seed + cases {
        let mut rng = Rng::new(case);
        let sources = random_sources(&mut rng);
        let cfg = random_config(&mut rng);
        let context = format!("case {case} ({} sources, {cfg:?})", sources.len());
        assert_matches_oracle(cfg, &sources, &mut Host { rng: Rng::new(case ^ 0xfeed), early: 3 }, &context);
    }
}

#[test]
fn a_flipped_byte_never_reaches_done() {
    let cases = env("ENGINE_PROP_CASES", 300);
    let seed = env("ENGINE_PROP_SEED", 1);
    let mut refused = 0;
    for case in seed..seed + cases {
        let mut rng = Rng::new(case ^ 0xbad);
        let mut sources = random_sources(&mut rng);
        if sources.is_empty() {
            continue;
        }
        let s = rng.below(sources.len());
        let r = rng.below(sources[s].len());
        let run = &mut sources[s][r];
        let at = rng.below(run.len());
        run[at] ^= 1 << rng.below(8);
        let cfg = random_config(&mut rng);
        match drive(cfg, &sources, &mut host(case)) {
            Err(MergeError::Corrupt(_)) => refused += 1,
            other => panic!("case {case}: flipped byte {at} of run {r} of source {s} gave {:?}", other.map(|_| ())),
        }
    }
    assert!(refused > cases / 2, "{refused} of {cases} cases refused");
}

/// Every byte of a small set of sources, flipped one at a time.
#[test]
fn every_single_byte_flip_is_refused() {
    let mut rng = Rng::new(77);
    let a: Vec<Entry> = (0..40).map(|i| put(format!("k{i:03}").as_bytes(), &rng.bytes(30), i)).collect();
    let b: Vec<Entry> = (0..40).map(|i| del(format!("k{:03}", i * 2).as_bytes(), 100 + i)).collect();
    let sources = vec![
        vec![encode_sst(&a[..25], Codec::Raw), encode_sst(&a[25..], Codec::Lz4)],
        vec![encode_sst(&b, Codec::Lz4)],
    ];
    let mut cfg = config(true, 500, Codec::Raw);
    cfg.chunk_bytes = 300;
    cfg.tail_bytes = 64;
    assert_matches_oracle(cfg, &sources, &mut host(0), "unflipped");
    for s in 0..sources.len() {
        for r in 0..sources[s].len() {
            for at in 0..sources[s][r].len() {
                for flip in [0x01, 0x80, 0xff] {
                    let mut bad = sources.clone();
                    bad[s][r][at] ^= flip;
                    let got = drive(cfg, &bad, &mut host(at as u64));
                    assert!(matches!(got, Err(MergeError::Corrupt(_))), "source {s} run {r} byte {at} ^ {flip:#x}: {got:?}");
                }
            }
        }
    }
}

#[test]
fn newer_wins() {
    let older = encode_sst(&[put(b"k", b"old", 1)], Codec::Raw);
    let newer = encode_sst(&[put(b"k", b"new", 2)], Codec::Raw);
    let (out, dropped) = merge(&[newer, older], false, usize::MAX, Codec::Raw).unwrap();
    assert_eq!(entries(&out), vec![put(b"k", b"new", 2)]);
    assert_eq!(dropped, 0);
}

#[test]
fn bottom_merge_drops_tombstones() {
    let older = encode_sst(&[put(b"a", b"1", 1), put(b"b", b"1", 1)], Codec::Raw);
    let newer = encode_sst(&[del(b"a", 5)], Codec::Raw);
    let (kept, _) = merge(&[newer.clone(), older.clone()], false, usize::MAX, Codec::Raw).unwrap();
    assert_eq!(entries(&kept), vec![del(b"a", 5), put(b"b", b"1", 1)]);
    let (out, dropped) = merge(&[newer, older], true, usize::MAX, Codec::Raw).unwrap();
    assert_eq!(entries(&out), vec![put(b"b", b"1", 1)]);
    assert_eq!(dropped, 5);
}

/// A put expired at `judge_now` must keep hiding older versions, so a merge
/// that is not at the bottom writes it as a tombstone with its own seq. A
/// bottom merge drops it like a tombstone. A put that expires later is kept
/// with its expiry.
#[test]
fn an_expired_put_becomes_a_tombstone_or_drops_at_the_bottom() {
    let older = encode_sst(&[put(b"a", b"old", 1), put(b"b", b"old", 1), put(b"c", b"old", 1)], Codec::Raw);
    let newer = encode_sst(&[put_until(b"a", b"new", 4, 10), put_until(b"b", b"new", 5, 11), put(b"c", b"new", 6)], Codec::Raw);
    let with = |drop_tombstones, judge_now| {
        let sources = [vec![newer.clone()], vec![older.clone()]];
        let cfg = MergeConfig { judge_now, ..config(drop_tombstones, usize::MAX, Codec::Raw) };
        assert_matches_oracle(cfg, &sources, &mut host(9), "expiry");
        drive(cfg, &sources, &mut host(9)).unwrap()
    };
    let (out, dropped) = with(false, 10);
    assert_eq!(entries(&out), vec![del(b"a", 4), put_until(b"b", b"new", 5, 11), put(b"c", b"new", 6)]);
    assert_eq!(dropped, 0);
    let (out, dropped) = with(true, 10);
    assert_eq!(entries(&out), vec![put_until(b"b", b"new", 5, 11), put(b"c", b"new", 6)]);
    assert_eq!(dropped, 4);
    let (out, _) = with(false, 0);
    assert_eq!(entries(&out), vec![put_until(b"a", b"new", 4, 10), put_until(b"b", b"new", 5, 11), put(b"c", b"new", 6)], "0 judges nothing");
}

#[test]
fn splits_output_at_key_boundaries() {
    let rows: Vec<Entry> = (0..100u64).map(|i| put(format!("k{i:03}").as_bytes(), &[b'x'; 50], i)).collect();
    let (out, _) = merge(&[encode_sst(&rows, Codec::Raw)], false, 1000, Codec::Raw).unwrap();
    assert!(out.len() > 1);
    assert_eq!(entries(&out), rows);
    let (none, _) = merge(&[encode_sst(&[del(b"a", 1)], Codec::Raw)], true, 1000, Codec::Raw).unwrap();
    assert!(none.is_empty());
}

fn fix_crc(run: &mut [u8]) {
    let at = run.len() - 12;
    let sum = crc32(&run[..at]);
    run[at..at + 4].copy_from_slice(&sum.to_le_bytes());
}

#[test]
fn an_input_out_of_key_order_is_refused() {
    let ordered = encode_sst(&[put(b"a", b"1", 1), put(b"b", b"2", 2)], Codec::Raw);
    let mut flipped = ordered.clone();
    // Swap the two keys in place (same length, so the layout holds), then fix the CRC.
    let (a, b) = (flipped.iter().position(|&x| x == b'a').unwrap(), flipped.iter().position(|&x| x == b'b').unwrap());
    flipped.swap(a, b);
    fix_crc(&mut flipped);
    assert_eq!(decode_sst(&flipped).unwrap().iter().map(|e| e.key().to_vec()).collect::<Vec<_>>(), vec![b"b".to_vec(), b"a".to_vec()]);
    assert_eq!(merge(&[flipped], false, usize::MAX, Codec::Raw).err(), Some(MergeError::Corrupt(SstError::OutOfOrder)));
    assert!(merge(&[ordered], false, usize::MAX, Codec::Raw).is_ok());
}

/// Two entries whose blocks have the same length, one block each.
fn two_block_run() -> Vec<u8> {
    let run = encode_sst(&[put(b"a", &[1; 4_000], 1), put(b"b", &[2; 4_000], 2)], Codec::Raw);
    assert_eq!(read_u32(&run, run.len() - FOOTER_BYTES + 4), 2, "two blocks");
    run
}

#[test]
fn a_footer_that_miscounts_its_entries_is_refused() {
    let mut run = two_block_run();
    let at = run.len() - FOOTER_BYTES;
    run[at..at + 4].copy_from_slice(&3u32.to_le_bytes());
    fix_crc(&mut run);
    assert_eq!(decode_sst(&run).err(), Some(SstError::CountMismatch));
    assert_eq!(merge(&[run], false, usize::MAX, Codec::Raw).err(), Some(MergeError::Corrupt(SstError::CountMismatch)));
}

/// The session reads blocks back to back, so an index whose blocks do not
/// tile the data in order is refused, even one `decode_sst` reads: here the
/// rows are swapped and `decode_sst` returns the keys backwards.
#[test]
fn an_index_whose_blocks_do_not_tile_the_data_is_refused() {
    let mut run = two_block_run();
    let layout = read_footer(&run[run.len() - FOOTER_BYTES..], run.len()).unwrap();
    let row = (layout.index_end - layout.index_start) / 2;
    let (first, second) = run[layout.index_start..layout.index_end].split_at_mut(row);
    first.swap_with_slice(second);
    fix_crc(&mut run);
    let keys: Vec<Vec<u8>> = decode_sst(&run).unwrap().iter().map(|e| e.key().to_vec()).collect();
    assert_eq!(keys, vec![b"b".to_vec(), b"a".to_vec()]);
    assert_eq!(merge(&[run], false, usize::MAX, Codec::Raw).err(), Some(MergeError::Corrupt(SstError::Truncated)));
}

/// A source's runs are one stream: a later run whose keys go back is
/// refused, even where the oracle would have dropped the stray entry.
#[test]
fn runs_of_one_source_must_follow_each_other() {
    let first = encode_sst(&[put(b"b", b"1", 1)], Codec::Raw);
    let second = encode_sst(&[del(b"a", 2)], Codec::Raw);
    let got = drive(config(true, usize::MAX, Codec::Raw), &[vec![first, second]], &mut host(3));
    assert_eq!(got.err(), Some(MergeError::Corrupt(SstError::OutOfOrder)));
}

#[test]
fn newest_of_many_overlapping_runs_wins() {
    let runs: Vec<Vec<Entry>> = (0..3u64)
        .map(|r| (0..30u64).filter(|i| i % (r + 1) == 0).map(|i| put(format!("k{i:02}").as_bytes(), &[b'0' + r as u8], 10 - r)).collect())
        .collect();
    let blobs: Vec<Vec<u8>> = runs.iter().map(|r| encode_sst(r, Codec::Raw)).collect();
    let (out, _) = merge(&blobs, false, 200, Codec::Raw).unwrap();
    let want: Vec<Entry> = (0..30u64).map(|i| put(format!("k{i:02}").as_bytes(), b"0", 10)).collect();
    assert_eq!(entries(&out), want);
    let (reversed, _) = merge(&blobs.iter().rev().cloned().collect::<Vec<_>>(), false, usize::MAX, Codec::Raw).unwrap();
    let newest = |i: u64| [2u64, 1, 0].into_iter().find(|r| i % (r + 1) == 0).unwrap();
    let want: Vec<Entry> = (0..30u64).map(|i| put(format!("k{i:02}").as_bytes(), &[b'0' + newest(i) as u8], 10 - newest(i))).collect();
    assert_eq!(entries(&reversed), want);
}

/// Later duplicates in the winning source win, including a put that follows
/// a delete of the same key, and a dropped tombstone reports its own seq.
#[test]
fn last_duplicate_in_the_newest_run_wins() {
    let newest = encode_sst(&[put(b"a", b"first", 1), del(b"a", 2), put(b"a", b"last", 3), put(b"b", b"b", 4)], Codec::Raw);
    let older = encode_sst(&[put(b"a", b"old", 9), del(b"a", 8), put(b"b", b"old-b", 1)], Codec::Raw);
    let (out, dropped) = merge(&[newest.clone(), older.clone()], false, usize::MAX, Codec::Raw).unwrap();
    assert_eq!(entries(&out), vec![put(b"a", b"last", 3), put(b"b", b"b", 4)]);
    assert_eq!(dropped, 0);
    let (out, dropped) = merge(&[newest, older], true, 1, Codec::Raw).unwrap();
    assert_eq!(dropped, 0);
    assert_eq!(entries(&out), vec![put(b"a", b"last", 3), put(b"b", b"b", 4)]);

    let newest_del = encode_sst(&[put(b"a", b"first", 1), del(b"a", 6)], Codec::Raw);
    let (out, dropped) = merge(&[newest_del], true, usize::MAX, Codec::Raw).unwrap();
    assert!(out.is_empty());
    assert_eq!(dropped, 6);
}

/// A key repeated on both sides of a run boundary inside one source: the
/// later run's entry is the later duplicate.
#[test]
fn the_last_duplicate_wins_across_a_run_boundary() {
    let first = encode_sst(&[put(b"a", b"1", 1), put(b"k", b"early", 2)], Codec::Raw);
    let second = encode_sst(&[put(b"k", b"late", 3), put(b"z", b"9", 4)], Codec::Lz4);
    let older = encode_sst(&[put(b"k", b"older", 9)], Codec::Raw);
    let sources = vec![vec![first, second], vec![older]];
    let (out, _) = drive(config(false, usize::MAX, Codec::Raw), &sources, &mut host(5)).unwrap();
    assert_eq!(entries(&out), vec![put(b"a", b"1", 1), put(b"k", b"late", 3), put(b"z", b"9", 4)]);
    assert_matches_oracle(config(false, 1, Codec::Raw), &sources, &mut host(6), "boundary");
}

/// Duplicates spread over many blocks, with read windows of one block.
#[test]
fn the_last_duplicate_wins_across_blocks_and_reads() {
    let rows: Vec<Entry> = (0..60).map(|i| put(b"same", &[i as u8; 1_500], i)).collect();
    let mut cfg = config(false, usize::MAX, Codec::Raw);
    cfg.chunk_bytes = 1;
    cfg.tail_bytes = 0;
    for codec in [Codec::Raw, Codec::Lz4] {
        let sources = vec![vec![encode_sst(&rows[..30], codec), encode_sst(&rows[30..], codec)]];
        let (out, _) = drive(cfg, &sources, &mut host(7)).unwrap();
        assert_eq!(entries(&out), vec![rows[59].clone()]);
    }
}

#[test]
fn writes_the_codec_it_is_given_and_reads_either() {
    let rows: Vec<Entry> = (0..300u64).map(|i| put(format!("k{i:03}").as_bytes(), &[b'x'; 40], i)).collect();
    let raw = encode_sst(&rows, Codec::Raw);
    let (packed, _) = merge(&[raw.clone()], false, usize::MAX, Codec::Lz4).unwrap();
    assert!(packed[0].bytes.len() < raw.len() / 2);
    let (back, _) = merge(&[packed[0].bytes.clone()], false, usize::MAX, Codec::Raw).unwrap();
    assert!(back[0].bytes == raw);
}

#[test]
fn empty_inputs_merge_to_nothing() {
    let empty = encode_sst(&[], Codec::Raw);
    let empty_lz4 = encode_sst(&[], Codec::Lz4);
    for sources in [vec![], vec![vec![]], vec![vec![empty.clone()]], vec![vec![empty.clone(), empty_lz4.clone()], vec![], vec![empty_lz4]]] {
        let (out, dropped) = drive(config(true, 0, Codec::Lz4), &sources, &mut host(8)).unwrap();
        assert!(out.is_empty());
        assert_eq!(dropped, 0);
    }
}

/// A value larger than the read window: the window grows to hold its block.
#[test]
fn a_value_larger_than_the_window_is_merged() {
    let mut rng = Rng::new(9);
    let huge = rng.bytes(3 * 1024 * 1024);
    let rows = vec![put(b"a", b"1", 1), put(b"b", &huge, 2), put(b"c", b"3", 3)];
    let older = vec![put(b"b", b"old", 0), put(b"d", &huge[..300_000], 0)];
    let mut cfg = config(false, 1_000_000, Codec::Raw);
    cfg.chunk_bytes = 64 * 1024;
    for codec in [Codec::Raw, Codec::Lz4] {
        let sources = vec![vec![encode_sst(&rows, codec)], vec![encode_sst(&older, codec)]];
        assert_matches_oracle(cfg, &sources, &mut host(10), "huge value");
        let (out, _) = drive(cfg, &sources, &mut host(11)).unwrap();
        assert_eq!(entries(&out), vec![rows[0].clone(), rows[1].clone(), rows[2].clone(), older[1].clone()]);
    }
}

fn demand_count(cfg: MergeConfig, sources: &[Vec<Vec<u8>>]) -> usize {
    let sizes: Vec<Vec<u32>> = sources.iter().map(|runs| runs.iter().map(|r| r.len() as u32).collect()).collect();
    let mut session = MergeSession::open(cfg, &sizes).unwrap();
    let mut count = 0;
    loop {
        match session.pump().unwrap() {
            Stop::Need(demands) => {
                let demands = demands.to_vec();
                count += demands.len();
                for d in &demands {
                    feed(&mut session, sources, d);
                }
            }
            Stop::Done(_) => return count,
            _ => {}
        }
    }
}

/// A run that fits the tail read is read once; a larger one is read as its
/// tail, then its blocks a window at a time.
#[test]
fn reads_follow_the_tail_and_the_window() {
    let rows: Vec<Entry> = (0..2_000u64).map(|i| put(format!("k{i:05}").as_bytes(), &[7; 100], i)).collect();
    let run = encode_sst(&rows, Codec::Raw);
    let sources = vec![vec![run.clone()]];
    let mut cfg = config(false, usize::MAX, Codec::Raw);
    cfg.tail_bytes = run.len();
    assert_eq!(demand_count(cfg, &sources), 1);
    cfg.tail_bytes = 1_000;
    cfg.chunk_bytes = 64 * 1024;
    let meta_and_data = 1 + 1 + run.len().div_ceil(64 * 1024);
    let n = demand_count(cfg, &sources);
    assert!(n >= meta_and_data && n <= meta_and_data + 3, "{n} demands for a {} byte run", run.len());
}

#[test]
fn feed_takes_only_a_listed_demand() {
    let run = encode_sst(&[put(b"a", b"1", 1)], Codec::Raw);
    let mut session = MergeSession::open(config(false, usize::MAX, Codec::Raw), &[vec![run.len() as u32]]).unwrap();
    assert!(session.feed(0, run.len()).is_none(), "nothing asked yet");
    let Ok(Stop::Need(demands)) = session.pump() else { panic!("expected a need") };
    let d = demands[0];
    assert_eq!((d.source, d.run, d.offset, d.len as usize), (0, 0, 0, run.len()));
    assert!(session.feed(1, run.len()).is_none(), "no such source");
    assert!(session.feed(0, run.len() - 1).is_none(), "wrong length");
    assert_eq!(session.pump(), Err(MergeError::Unfed));
    session.feed(0, run.len()).unwrap().copy_from_slice(&run);
    assert!(session.feed(0, run.len()).is_none(), "fed once");
    assert!(matches!(session.pump(), Ok(Stop::Write(_))));
}

#[test]
fn a_failed_session_keeps_failing() {
    let mut run = encode_sst(&[put(b"a", b"1", 1)], Codec::Raw);
    run[0] ^= 1;
    let mut session = MergeSession::open(config(false, usize::MAX, Codec::Raw), &[vec![run.len() as u32]]).unwrap();
    let Ok(Stop::Need(_)) = session.pump() else { panic!("expected a need") };
    session.feed(0, run.len()).unwrap().copy_from_slice(&run);
    let err = session.pump().unwrap_err();
    assert!(matches!(err, MergeError::Corrupt(_)));
    assert_eq!(session.pump().unwrap_err(), err);
    assert!(session.feed(0, run.len()).is_none());
}

#[test]
fn a_run_shorter_than_a_footer_is_refused_at_open() {
    let got = MergeSession::open(config(false, 0, Codec::Raw), &[vec![100, 43]]).err();
    assert_eq!(got, Some(MergeError::Corrupt(SstError::TooShort)));
}

/// Yields come between keys and leave the output as it would be without.
#[test]
fn yields_come_after_about_yield_bytes() {
    let rows: Vec<Entry> = (0..3_000u64).map(|i| put(format!("k{i:05}").as_bytes(), &[3; 200], i)).collect();
    let run = encode_sst(&rows, Codec::Raw);
    let mut cfg = config(false, usize::MAX, Codec::Raw);
    cfg.yield_bytes = 64 * 1024;
    let mut session = MergeSession::open(cfg, &[vec![run.len() as u32]]).unwrap();
    let mut yields = 0;
    loop {
        match session.pump().unwrap() {
            Stop::Need(demands) => {
                let demands = demands.to_vec();
                for d in &demands {
                    feed(&mut session, &[vec![run.clone()]], d);
                }
            }
            Stop::Yield => yields += 1,
            Stop::Done(_) => break,
            _ => {}
        }
    }
    let expected = run.len() / (64 * 1024);
    assert!(yields + 2 >= expected && yields <= expected + 2, "{yields} yields for {} bytes", run.len());
}

/// The session's block path decodes what `decode_sst` decodes.
#[test]
fn decode_block_matches_decode_sst() {
    let mut rng = Rng::new(12);
    for codec in [Codec::Raw, Codec::Lz4] {
        let rows = source_entries(&mut rng, 50);
        let run = encode_sst(&rows, codec);
        let layout = read_footer(&run[run.len() - FOOTER_BYTES..], run.len()).unwrap();
        let mut blocks = Vec::new();
        index_blocks(&run[layout.index_start..layout.index_end], layout.block_count, layout.data_len, &mut blocks).unwrap();
        let (mut at, mut all) = (0, Vec::new());
        for len in blocks {
            all.extend(decode_block(&run[at..at + len as usize], codec).unwrap());
            at += len as usize;
        }
        assert_eq!(all, decode_sst(&run).unwrap());
    }
}

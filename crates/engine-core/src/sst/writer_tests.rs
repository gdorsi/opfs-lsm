//! `SstWriter` against the frozen encoder in `reference.rs`: for the same
//! entries, the same bytes.

use super::*;
use std::path::PathBuf;

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
    fn bytes(&mut self, len: usize) -> Vec<u8> {
        (0..len).map(|_| self.next() as u8).collect()
    }
}

/// A key of one of the shapes the engine sees: random bytes (the empty key
/// and 0x00 and 0xff among them), a long head every key shares, a counter,
/// and long keys that differ only at the end.
fn key(rng: &mut Rng, i: usize, shape: usize) -> Vec<u8> {
    match shape {
        0 => {
            let len = rng.below(40);
            rng.bytes(len)
        }
        1 => format!("i/\x05\0todos\x09\0byCreated{:016x}{i:08}", 1_700_000 + i / 3).into_bytes(),
        2 => format!("todo/{i:013}").into_bytes(),
        _ => {
            let mut k = vec![b'k'; 495];
            k.extend_from_slice(format!("{:05}", i * 7 + rng.below(7)).as_bytes());
            k
        }
    }
}

fn value_len(rng: &mut Rng) -> usize {
    // Mostly small, sometimes past the 4 KiB block target, once past the u16 offsets.
    match rng.below(40) {
        0 => 70_000,
        1 | 2 => 4_500 + rng.below(2_000),
        3..=8 => rng.below(400),
        9..=14 => 0,
        _ => rng.below(60),
    }
}

fn entries(rng: &mut Rng) -> Vec<Entry> {
    let n = [0, 1, 2, 3, 5, 17, 100, 600, 3000][rng.below(9)];
    let shape = rng.below(4);
    let mut out: Vec<Entry> = Vec::with_capacity(n);
    for i in 0..n {
        let key = if i > 0 && rng.chance(12) { out[i - 1].key().to_vec() } else { key(rng, i, shape) };
        let seq = if rng.chance(20) { u64::MAX - rng.below(5) as u64 } else { rng.next() >> rng.below(64) };
        out.push(if rng.chance(5) {
            Entry::Del { key, seq }
        } else {
            let len = if shape == 3 { rng.below(30) } else { value_len(rng) };
            let expires_at = if rng.chance(3) { Some(rng.next() >> rng.below(64)) } else { None };
            Entry::Put { key, value: rng.bytes(len), seq, expires_at }
        });
    }
    if rng.chance(2) {
        // Any order: the encoder sorts, equal keys keep their order.
        for i in (1..out.len()).rev() {
            out.swap(i, rng.below(i + 1));
        }
    }
    out
}

fn sorted(entries: &[Entry]) -> Vec<Entry> {
    let mut s = entries.to_vec();
    s.sort_by(|a, b| a.key().cmp(b.key()));
    s
}

/// What the run must report: its entries, size and smallest and largest key.
fn assert_end(end: &RunEnd, bytes: &[u8], entries: &[Entry], context: &str) {
    let s = sorted(entries);
    assert_eq!(end.entries, s.len(), "{context}: entries");
    assert_eq!(end.size, bytes.len(), "{context}: size");
    assert_eq!(end.first_key, s.first().map_or(&[][..], |e| e.key()), "{context}: first key");
    assert_eq!(end.last_key, s.last().map_or(&[][..], |e| e.key()), "{context}: last key");
}

fn assert_same_bytes(entries: &[Entry], codec: Codec, context: &str) {
    let want = reference::encode_sst(entries, codec);
    let run = encode_run(entries, codec);
    assert!(run.bytes == want, "{context}: {codec:?} bytes differ ({} vs {} bytes)", run.bytes.len(), want.len());
    assert_end(&run.end, &run.bytes, entries, context);
    assert_eq!(decode_sst(&run.bytes).unwrap(), sorted(entries), "{context}: {codec:?} decodes to the sorted entries");
}

#[test]
fn random_runs_encode_to_the_reference_bytes() {
    for seed in 1..=120u64 {
        let mut rng = Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1);
        let entries = entries(&mut rng);
        for codec in [Codec::Raw, Codec::Lz4] {
            assert_same_bytes(&entries, codec, &format!("seed {seed}, {} entries", entries.len()));
        }
    }
}

#[test]
fn named_shapes_encode_to_the_reference_bytes() {
    let put = |k: &[u8], v: &[u8], seq: u64| Entry::Put { key: k.to_vec(), value: v.to_vec(), seq, expires_at: None };
    let del = |k: &[u8], seq: u64| Entry::Del { key: k.to_vec(), seq };
    let cases: Vec<(&str, Vec<Entry>)> = vec![
        ("empty", vec![]),
        ("one empty key", vec![put(b"", b"", 0)]),
        ("only tombstones", vec![del(b"b", 2), del(b"a", 1), del(b"c", 3)]),
        ("empty values", (0..300).map(|i| put(format!("k{i:04}").as_bytes(), b"", i)).collect()),
        ("equal keys", vec![put(b"a", b"1", 1), del(b"a", 2), put(b"a", b"3", 3), put(b"b", b"4", 4)]),
        ("prefix of the next", vec![put(b"a", b"1", 1), put(b"ab", b"2", 2), put(b"abc", b"3", 3), put(b"abd", b"4", 4)]),
        ("one value over the u16 offsets", vec![put(b"a", b"1", 1), put(b"b", &[7; 70_000], 2), put(b"c", b"3", 3)]),
        ("values over the block target", (0..40).map(|i| put(format!("k{i:02}").as_bytes(), &[9; 4_200], i)).collect()),
        ("many blocks", (0..30_000).map(|i| put(format!("k{i:08}").as_bytes(), b"v", i)).collect()),
        ("0xff keys", vec![put(&[0xff; 300], &[7; 200], 1), put(&[0xff; 301], b"", u64::MAX)]),
    ];
    for (name, entries) in cases {
        for codec in [Codec::Raw, Codec::Lz4] {
            assert_same_bytes(&entries, codec, name);
        }
    }
}

/// Sweep one value's length across the block target, so some block lands on
/// exactly `BLOCK_TARGET` bytes: the edge between staying in the block and
/// being cut to the next one.
#[test]
fn a_block_may_fill_the_target_exactly() {
    let put = |k: &[u8], v: &[u8], seq: u64| Entry::Put { key: k.to_vec(), value: v.to_vec(), seq, expires_at: None };
    let mut exact = 0;
    for pad in 0..400 {
        let mut entries: Vec<Entry> = (0..30).map(|i| put(format!("k{i:02}").as_bytes(), &[b'x'; 120], i)).collect();
        entries.push(put(b"k30", &vec![b'y'; pad], 30));
        entries.push(put(b"k31", b"z", 31));
        assert_same_bytes(&entries, Codec::Raw, &format!("pad {pad}"));
        let run = encode_run(&entries, Codec::Raw);
        let footer = run.bytes.len() - FOOTER_BYTES;
        let blocks = read_u32(&run.bytes, footer + 4);
        let data_len = read_u32(&run.bytes, footer + 8) as usize;
        if blocks == 1 && data_len > BLOCK_TARGET - 2 && data_len <= BLOCK_TARGET {
            exact += 1;
        }
    }
    assert!(exact >= 1, "no run filled one block to the target");
}

/// Every run in the fuzz corpus that decodes, or whose CRC a fuzz target
/// would fix, and every run of the merge session corpus: the entries a
/// decoder found there encode to the reference bytes.
#[test]
fn the_fuzz_corpus_encodes_to_the_reference_bytes() {
    let dir = |name: &str| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fuzz/corpus").join(name);
    let seeds = |name: &str| -> Vec<Vec<u8>> {
        let mut paths: Vec<_> = std::fs::read_dir(dir(name)).unwrap().map(|e| e.unwrap().path()).collect();
        paths.sort();
        paths.iter().map(|p| std::fs::read(p).unwrap()).collect()
    };

    let mut runs: Vec<Vec<u8>> = Vec::new();
    for seed in seeds("decode_sst") {
        let Some((&flags, rest)) = seed.split_first() else { continue };
        let mut buf = rest.to_vec();
        if flags & 1 != 0 && buf.len() >= FOOTER_BYTES {
            let at = buf.len() - 12;
            let sum = crc32(&buf[..at]);
            buf[at..at + 4].copy_from_slice(&sum.to_le_bytes());
        }
        runs.push(buf);
    }
    for seed in seeds("merge_session") {
        // A five-byte header, then each run as a u16 length and its bytes.
        let mut rest = seed.get(5..).unwrap_or_default();
        while rest.len() >= 2 {
            let n = u16::from_le_bytes([rest[0], rest[1]]) as usize;
            rest = &rest[2..];
            let take = n.min(rest.len());
            runs.push(rest[..take].to_vec());
            rest = &rest[take..];
        }
    }

    let mut decoded = 0;
    for run in &runs {
        let Ok(entries) = decode_sst(run) else { continue };
        decoded += 1;
        for codec in [Codec::Raw, Codec::Lz4] {
            assert_same_bytes(&entries, codec, "corpus run");
        }
    }
    assert!(decoded >= 10, "only {decoded} of {} corpus runs decode", runs.len());
}

/// Drive the writer by hand, moving `out` on at random points: the bytes it
/// appends are the run whatever the caller does with them in between.
#[test]
fn a_caller_can_drain_the_output_between_pushes() {
    for seed in 1..=40u64 {
        let mut rng = Rng(seed.wrapping_mul(0xd1b5_4a32_d192_ed03) | 1);
        let input = sorted(&entries(&mut rng));
        for codec in [Codec::Raw, Codec::Lz4] {
            let mut writer = SstWriter::new(codec);
            let (mut out, mut collected) = (Vec::new(), Vec::new());
            for e in &input {
                writer.push(e.into(), &mut out).unwrap();
                if rng.chance(3) {
                    collected.append(&mut out);
                }
            }
            let end = writer.finish(&mut out);
            collected.append(&mut out);
            assert!(collected == reference::encode_sst(&input, codec), "seed {seed} {codec:?}");
            assert_end(&end, &collected, &input, &format!("seed {seed}"));
        }
    }
}

#[test]
fn a_writer_is_ready_for_the_next_run_after_finish() {
    let mut rng = Rng(7);
    let first = sorted(&entries(&mut rng));
    let second = sorted(&entries(&mut rng));
    let third = sorted(&entries(&mut rng));
    for codec in [Codec::Raw, Codec::Lz4] {
        let mut writer = SstWriter::new(codec);
        assert!(writer.is_empty());
        for run in [&first, &second, &third] {
            let mut out = Vec::new();
            for e in run.iter() {
                writer.push(e.into(), &mut out).unwrap();
            }
            assert_eq!(writer.is_empty(), run.is_empty());
            let end = writer.finish(&mut out);
            assert!(writer.is_empty());
            assert!(out == reference::encode_sst(run, codec), "{codec:?}");
            assert_end(&end, &out, run, "reused writer");
        }
    }
}

#[test]
fn a_key_below_the_last_is_refused_and_changes_nothing() {
    let put = |k: &[u8], seq: u64| Entry::Put { key: k.to_vec(), value: b"v".to_vec(), seq, expires_at: None };
    for codec in [Codec::Raw, Codec::Lz4] {
        let mut writer = SstWriter::new(codec);
        let mut out = Vec::new();
        writer.push((&put(b"b", 1)).into(), &mut out).unwrap();
        writer.push((&put(b"b", 2)).into(), &mut out).unwrap();
        assert_eq!(writer.push((&put(b"a", 3)).into(), &mut out), Err(OutOfOrder));
        assert_eq!(writer.push(EntryRef::Del { key: b"", seq: 4 }, &mut out), Err(OutOfOrder));
        writer.push((&put(b"c", 5)).into(), &mut out).unwrap();
        let end = writer.finish(&mut out);
        let kept = [put(b"b", 1), put(b"b", 2), put(b"c", 5)];
        assert!(out == reference::encode_sst(&kept, codec), "{codec:?}");
        assert_end(&end, &out, &kept, "after refusals");
    }
}

#[test]
fn an_unsorted_pair_across_a_block_boundary_is_refused() {
    let mut writer = SstWriter::new(Codec::Raw);
    let mut out = Vec::new();
    let big = vec![1u8; 3_000];
    writer.push(EntryRef::Put { key: b"m", value: &big, seq: 1, expires_at: None }, &mut out).unwrap();
    writer.push(EntryRef::Put { key: b"n", value: &big, seq: 2, expires_at: None }, &mut out).unwrap();
    assert!(!out.is_empty(), "the first block is out");
    assert_eq!(writer.push(EntryRef::Del { key: b"a", seq: 3 }, &mut out), Err(OutOfOrder));
}

/// The open block holds no more bytes than the block it will become, so a
/// writer's memory does not follow the keys' length.
#[test]
fn the_open_block_is_held_in_no_more_bytes_than_it_is_written_in() {
    let mut rng = Rng(11);
    let mut writer = SstWriter::new(Codec::Raw);
    let mut out = Vec::new();
    let mut most = 0;
    for i in 0..4_000 {
        let k = key(&mut rng, i, 3);
        writer.push(EntryRef::Put { key: &k, value: b"v", seq: i as u64, expires_at: None }, &mut out).unwrap();
        most = most.max(writer.staged.len());
        out.clear();
    }
    assert!(writer.blocks > 10, "the test fills blocks: {}", writer.blocks);
    assert!(most <= BLOCK_TARGET, "{most} staged bytes for 500-byte keys");
}

/// Hand-checked bytes of a tiny run, so the reference is not the only witness.
#[test]
fn a_two_entry_run_has_the_documented_bytes() {
    let mut writer = SstWriter::new(Codec::Raw);
    let mut out = Vec::new();
    writer.push(EntryRef::Put { key: b"ab", value: b"1", seq: 5, expires_at: None }, &mut out).unwrap();
    writer.push(EntryRef::Del { key: b"ac", seq: 6 }, &mut out).unwrap();
    let end = writer.finish(&mut out);

    let mut block = vec![2, 0, 0, 0, 1, b'a'];
    block.extend_from_slice(&[TAG_PUT, 5, 0, 0, 0, 0, 0, 0, 0, 1, b'b', 1, b'1']);
    block.extend_from_slice(&[TAG_DEL, 6, 0, 0, 0, 0, 0, 0, 0, 1, b'c']);
    assert_eq!(&out[..block.len()], &block[..]);
    let bloom_len = 8; // 64 bits, the minimum
    let index_at = block.len() + bloom_len;
    let mut index = Vec::new();
    index.extend_from_slice(&2u32.to_le_bytes());
    index.extend_from_slice(b"ab");
    index.extend_from_slice(&2u32.to_le_bytes());
    index.extend_from_slice(b"ac");
    index.extend_from_slice(&0u32.to_le_bytes());
    index.extend_from_slice(&(block.len() as u32).to_le_bytes());
    assert_eq!(&out[index_at..index_at + index.len()], &index[..]);

    let footer = &out[out.len() - FOOTER_BYTES..];
    let field = |i: usize| u32::from_le_bytes(footer[4 * i..4 * i + 4].try_into().unwrap()) as usize;
    assert_eq!(
        [field(0), field(1), field(2), field(3), field(4), field(5), field(6), field(7)],
        [2, 1, block.len(), bloom_len, 7, index_at, index.len(), 0]
    );
    assert_eq!(field(8) as u32, crc32(&out[..out.len() - 12]));
    assert_eq!((field(9), field(10) as u32), (2, MAGIC));
    assert_eq!(end, RunEnd { entries: 2, size: out.len(), first_key: b"ab".to_vec(), last_key: b"ac".to_vec() });
}

//! The encoder as it was before `SstWriter`, kept as the oracle the writer
//! is tested against: same input, same bytes. Do not change it to follow the
//! writer. A change to the SST format changes both on purpose.
//!
//! Two deliberate differences from the code it was copied from: the sort is
//! std's stable sort, and the bloom filter is spelled out here, so neither
//! shares code with the writer.

use super::{Codec, Entry};
use crate::crc32::crc32;
use alloc::{vec, vec::Vec};

const MAGIC: u32 = 0x4f4c_5354; // OLST
const VERSION: u32 = 1;
const FOOTER_BYTES: usize = 44;
const TAG_PUT: u8 = 1;
const TAG_DEL: u8 = 2;
const BLOCK_TARGET: usize = 4 * 1024;
const OFFSET_STRIDE: usize = 4;

fn offset_table_bytes(count: usize) -> usize {
    2 * (count.saturating_sub(1) / OFFSET_STRIDE)
}

fn write_u32(buf: &mut [u8], o: &mut usize, v: u32) {
    buf[*o..*o + 4].copy_from_slice(&v.to_le_bytes());
    *o += 4;
}

fn varint_len(mut v: usize) -> usize {
    let mut n = 1;
    while v >= 0x80 {
        v >>= 7;
        n += 1;
    }
    n
}

fn write_varint(out: &mut Vec<u8>, mut v: usize) {
    while v >= 0x80 {
        out.push(v as u8 | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

fn common_prefix(a: &[u8], b: &[u8]) -> usize {
    a.iter().zip(b).take_while(|(x, y)| x == y).count()
}

fn record_overhead(e: &Entry) -> usize {
    let n = 1 + 8 + varint_len(e.key().len());
    match e {
        Entry::Put { value, .. } => n + varint_len(value.len()) + value.len(),
        Entry::Del { .. } => n,
    }
}

fn split_blocks<'a>(sorted: &'a [&'a Entry]) -> Vec<&'a [&'a Entry]> {
    let mut blocks = Vec::new();
    let mut start = 0;
    let (mut keys, mut overhead) = (0usize, 0usize);
    for (i, e) in sorted.iter().enumerate() {
        if i > start {
            let p = common_prefix(sorted[start].key(), e.key());
            let n = i + 1 - start;
            let size = 4 + varint_len(p) + p + overhead + record_overhead(e) + keys + e.key().len() - n * p
                + offset_table_bytes(n);
            if size > BLOCK_TARGET {
                blocks.push(&sorted[start..i]);
                start = i;
                keys = 0;
                overhead = 0;
            }
        }
        keys += e.key().len();
        overhead += record_overhead(e);
    }
    if start < sorted.len() || blocks.is_empty() {
        blocks.push(&sorted[start..]);
    }
    blocks
}

fn encode_block(block: &[&Entry]) -> Vec<u8> {
    let p = match (block.first(), block.last()) {
        (Some(a), Some(b)) => common_prefix(a.key(), b.key()),
        _ => 0,
    };
    let mut out = Vec::with_capacity(BLOCK_TARGET + 64);
    out.extend_from_slice(&(block.len() as u32).to_le_bytes());
    write_varint(&mut out, p);
    if let Some(first) = block.first() {
        out.extend_from_slice(&first.key()[..p]);
    }
    let mut offsets = Vec::with_capacity(offset_table_bytes(block.len()));
    for (i, e) in block.iter().enumerate() {
        if i > 0 && i % OFFSET_STRIDE == 0 {
            offsets.extend_from_slice(&(out.len() as u16).to_le_bytes());
        }
        write_record(&mut out, e, p);
    }
    out.extend_from_slice(&offsets);
    out
}

fn write_record(out: &mut Vec<u8>, e: &Entry, prefix_len: usize) {
    let suffix = &e.key()[prefix_len..];
    out.push(match e {
        Entry::Put { .. } => TAG_PUT,
        Entry::Del { .. } => TAG_DEL,
    });
    out.extend_from_slice(&e.seq().to_le_bytes());
    write_varint(out, suffix.len());
    out.extend_from_slice(suffix);
    if let Entry::Put { value, .. } = e {
        write_varint(out, value.len());
        out.extend_from_slice(value);
    }
}

struct Bloom {
    bits: Vec<u8>,
    hash_count: u32,
}

fn bloom_new(key_count: usize) -> Bloom {
    let bits_per_key = 10usize;
    let bit_count = (key_count.max(1) * bits_per_key).max(64);
    let hash_count = (((bits_per_key as f64) * core::f64::consts::LN_2 + 0.5) as u32).max(1);
    Bloom { bits: vec![0u8; bit_count.div_ceil(8)], hash_count }
}

fn bloom_add(filter: &mut Bloom, key: &[u8]) {
    let mut h1 = 2166136261u32;
    for &b in key {
        h1 ^= u32::from(b);
        h1 = h1.wrapping_mul(16777619);
    }
    let mut h = h1;
    h ^= h >> 16;
    h = h.wrapping_mul(0x7feb_352d);
    h ^= h >> 15;
    h = h.wrapping_mul(0x846c_a68b);
    h ^= h >> 16;
    let h2 = h | 1;
    let m = filter.bits.len() * 8;
    for i in 0..filter.hash_count {
        let bit = ((h1.wrapping_add(i.wrapping_mul(h2))) as usize) % m;
        filter.bits[bit >> 3] |= 1 << (bit & 7);
    }
}

pub(super) fn encode_sst(entries: &[Entry], codec: Codec) -> Vec<u8> {
    let mut sorted: Vec<&Entry> = entries.iter().collect();
    sorted.sort_by(|a, b| a.key().cmp(b.key()));

    let blocks = split_blocks(&sorted);

    let mut bloom = bloom_new(sorted.len());
    for e in &sorted {
        bloom_add(&mut bloom, e.key());
    }

    let mut block_blobs: Vec<Vec<u8>> = Vec::new();
    let mut index: Vec<(Vec<u8>, Vec<u8>, u32, u32)> = Vec::new();
    let mut data_len = 0usize;
    for block in &blocks {
        let blob = encode_block(block);
        let blob = match codec {
            Codec::Raw => blob,
            Codec::Lz4 => {
                let mut packed = (blob.len() as u32).to_le_bytes().to_vec();
                packed.extend(lz4_flex::block::compress(&blob));
                packed
            }
        };
        let first = block.first().map(|e| e.key().to_vec()).unwrap_or_default();
        let last = block.last().map(|e| e.key().to_vec()).unwrap_or_default();
        index.push((first, last, data_len as u32, blob.len() as u32));
        data_len += blob.len();
        block_blobs.push(blob);
    }

    let mut index_size = 0usize;
    for (first, last, _, _) in &index {
        index_size += 4 + first.len() + 4 + last.len() + 8;
    }

    let total = data_len + bloom.bits.len() + index_size + FOOTER_BYTES;
    let mut out = vec![0u8; total];
    let mut o = 0usize;
    for blob in &block_blobs {
        out[o..o + blob.len()].copy_from_slice(blob);
        o += blob.len();
    }
    out[o..o + bloom.bits.len()].copy_from_slice(&bloom.bits);
    o += bloom.bits.len();

    let index_offset = o;
    for (first, last, offset, length) in &index {
        write_u32(&mut out, &mut o, first.len() as u32);
        out[o..o + first.len()].copy_from_slice(first);
        o += first.len();
        write_u32(&mut out, &mut o, last.len() as u32);
        out[o..o + last.len()].copy_from_slice(last);
        o += last.len();
        write_u32(&mut out, &mut o, *offset);
        write_u32(&mut out, &mut o, *length);
    }

    for field in [
        sorted.len(),
        blocks.len(),
        data_len,
        bloom.bits.len(),
        bloom.hash_count as usize,
        index_offset,
        index_size,
        codec as usize,
    ] {
        write_u32(&mut out, &mut o, field as u32);
    }
    let sum = crc32(&out[..o]);
    write_u32(&mut out, &mut o, sum);
    write_u32(&mut out, &mut o, VERSION);
    write_u32(&mut out, &mut o, MAGIC);
    debug_assert_eq!(o, out.len());
    out
}

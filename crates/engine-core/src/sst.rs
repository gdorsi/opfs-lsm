//! SST format. v1 (single block) and v2 (multi-block + Bloom) decode. v3 is
//! v2 with a u64 seq after each record tag. v4 is v3 with u32 Bloom header
//! fields, so a filter can pass 64 KiB. v5 is what encode writes: v4's
//! sections with the Bloom filter and index after the data, and a fixed
//! footer at the end.
//! Must stay byte-compatible with `packages/kv/src/store/sst.ts`.

use crate::bloom::{bloom_add, create_bloom};
use crate::crc32::crc32;

const MAGIC: u32 = 0x4f4c_5354; // OLST
const VERSION_V1: u32 = 1;
const VERSION_V2: u32 = 2;
const VERSION_V3: u32 = 3;
const VERSION_V4: u32 = 4;
const VERSION_V5: u32 = 5;
const FOOTER_BYTES: usize = 40;
const TAG_PUT: u8 = 1;
const TAG_DEL: u8 = 2;
const BLOCK_TARGET: usize = 4 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
/// `seq` is the WAL seq that wrote the entry, or 0 when the SST predates v3.
pub enum Entry {
    Put { key: Vec<u8>, value: Vec<u8>, seq: u64 },
    Del { key: Vec<u8>, seq: u64 },
}

impl Entry {
    pub fn key(&self) -> &[u8] {
        match self {
            Entry::Put { key, .. } | Entry::Del { key, .. } => key,
        }
    }

    pub fn seq(&self) -> u64 {
        match self {
            Entry::Put { seq, .. } | Entry::Del { seq, .. } => *seq,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SstError {
    TooShort,
    BadMagic(u32),
    BadVersion(u32),
    CrcMismatch,
    Truncated,
    BadTag(u8),
    TrailingGarbage,
    CountMismatch,
}

impl std::fmt::Display for SstError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for SstError {}

pub(crate) fn entry_size(e: &Entry) -> usize {
    let mut n = 1 + 8 + 4 + e.key().len();
    if let Entry::Put { value, .. } = e {
        n += 4 + value.len();
    }
    n
}

fn write_u32(buf: &mut [u8], o: &mut usize, v: u32) {
    buf[*o..*o + 4].copy_from_slice(&v.to_le_bytes());
    *o += 4;
}

fn read_u32(buf: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(buf[o..o + 4].try_into().unwrap())
}

fn read_u16(buf: &[u8], o: usize) -> u16 {
    u16::from_le_bytes(buf[o..o + 2].try_into().unwrap())
}

fn write_records(out: &mut [u8], o: &mut usize, entries: &[&Entry]) {
    for e in entries {
        match e {
            Entry::Put { key, value, seq } => {
                out[*o] = TAG_PUT;
                *o += 1;
                out[*o..*o + 8].copy_from_slice(&seq.to_le_bytes());
                *o += 8;
                write_u32(out, o, key.len() as u32);
                out[*o..*o + key.len()].copy_from_slice(key);
                *o += key.len();
                write_u32(out, o, value.len() as u32);
                out[*o..*o + value.len()].copy_from_slice(value);
                *o += value.len();
            }
            Entry::Del { key, seq } => {
                out[*o] = TAG_DEL;
                *o += 1;
                out[*o..*o + 8].copy_from_slice(&seq.to_le_bytes());
                *o += 8;
                write_u32(out, o, key.len() as u32);
                out[*o..*o + key.len()].copy_from_slice(key);
                *o += key.len();
            }
        }
    }
}

/// Encode SST v5:
///   data blocks | bloom bits | block index | footer (40 bytes)
/// The footer is u32 entry count, block count, bloom offset, bloom length,
/// bloom hash count, index offset, index length, then a u32 CRC of every
/// byte before it, u32 version 5 and u32 magic.
pub fn encode_sst(entries: &[Entry]) -> Vec<u8> {
    let mut sorted: Vec<&Entry> = entries.iter().collect();
    sorted.sort_by(|a, b| a.key().cmp(b.key()));

    let mut blocks: Vec<Vec<&Entry>> = Vec::new();
    let mut cur: Vec<&Entry> = Vec::new();
    let mut cur_size = 4usize;
    for e in &sorted {
        let need = entry_size(e);
        if !cur.is_empty() && cur_size + need > BLOCK_TARGET {
            blocks.push(cur);
            cur = Vec::new();
            cur_size = 4;
        }
        cur.push(*e);
        cur_size += need;
    }
    if !cur.is_empty() || blocks.is_empty() {
        blocks.push(cur);
    }

    let mut bloom = create_bloom(sorted.len().max(1), 10);
    for e in &sorted {
        bloom_add(&mut bloom, e.key());
    }

    let mut block_blobs: Vec<Vec<u8>> = Vec::new();
    let mut index: Vec<(Vec<u8>, Vec<u8>, u32, u32)> = Vec::new();
    let mut data_len = 0usize;
    for block in &blocks {
        let size = 4 + block.iter().map(|e| entry_size(e)).sum::<usize>();
        let mut blob = vec![0u8; size];
        let mut o = 0usize;
        write_u32(&mut blob, &mut o, block.len() as u32);
        write_records(&mut blob, &mut o, block);
        let first = block.first().map(|e| e.key().to_vec()).unwrap_or_default();
        let last = block.last().map(|e| e.key().to_vec()).unwrap_or_default();
        index.push((first, last, data_len as u32, size as u32));
        data_len += size;
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
    ] {
        write_u32(&mut out, &mut o, field as u32);
    }
    let sum = crc32(&out[..o]);
    write_u32(&mut out, &mut o, sum);
    write_u32(&mut out, &mut o, VERSION_V5);
    write_u32(&mut out, &mut o, MAGIC);
    debug_assert_eq!(o, out.len());
    out
}

fn read_records(
    buf: &[u8],
    mut o: usize,
    end: usize,
    count: usize,
    with_seq: bool,
) -> Result<Vec<Entry>, SstError> {
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        if o >= end {
            return Err(SstError::Truncated);
        }
        let tag = buf[o];
        o += 1;
        let mut seq = 0u64;
        if with_seq {
            if o + 8 > end {
                return Err(SstError::Truncated);
            }
            seq = u64::from_le_bytes(buf[o..o + 8].try_into().unwrap());
            o += 8;
        }
        if o + 4 > end {
            return Err(SstError::Truncated);
        }
        let key_len = read_u32(buf, o) as usize;
        o += 4;
        if o + key_len > end {
            return Err(SstError::Truncated);
        }
        let key = buf[o..o + key_len].to_vec();
        o += key_len;
        match tag {
            TAG_PUT => {
                if o + 4 > end {
                    return Err(SstError::Truncated);
                }
                let val_len = read_u32(buf, o) as usize;
                o += 4;
                if o + val_len > end {
                    return Err(SstError::Truncated);
                }
                let value = buf[o..o + val_len].to_vec();
                o += val_len;
                out.push(Entry::Put { key, value, seq });
            }
            TAG_DEL => out.push(Entry::Del { key, seq }),
            other => return Err(SstError::BadTag(other)),
        }
    }
    if o != end {
        return Err(SstError::TrailingGarbage);
    }
    Ok(out)
}

fn decode_v1(buf: &[u8], crc_off: usize) -> Result<Vec<Entry>, SstError> {
    let count = read_u32(buf, 8) as usize;
    read_records(buf, 12, crc_off, count, false)
}

/// Where the sections of a multi-block run are. `crc_off` holds the CRC of
/// every byte before it.
#[derive(Clone, Copy)]
struct Layout {
    entry_count: usize,
    block_count: usize,
    data_start: usize,
    data_len: usize,
    index_start: usize,
    index_end: usize,
    crc_off: usize,
}

fn legacy_layout(buf: &[u8], version: u32) -> Result<Layout, SstError> {
    if buf.len() < 32 {
        return Err(SstError::TooShort);
    }
    let crc_off = buf.len() - 4;
    let data_len = read_u32(buf, 16) as usize;
    let data_start = if version >= VERSION_V4 {
        28 + read_u32(buf, 24) as usize
    } else {
        24 + read_u16(buf, 22) as usize
    };
    let index_start = data_start + data_len;
    if index_start > crc_off {
        return Err(SstError::Truncated);
    }
    Ok(Layout {
        entry_count: read_u32(buf, 8) as usize,
        block_count: read_u32(buf, 12) as usize,
        data_start,
        data_len,
        index_start,
        index_end: crc_off,
        crc_off,
    })
}

fn v5_layout(buf: &[u8]) -> Result<Layout, SstError> {
    let footer = buf.len() - FOOTER_BYTES;
    let field = |i: usize| read_u32(buf, footer + 4 * i) as usize;
    let (bloom_offset, bloom_len, index_offset, index_len) = (field(2), field(3), field(5), field(6));
    if index_offset != bloom_offset + bloom_len || index_offset + index_len != footer {
        return Err(SstError::Truncated);
    }
    Ok(Layout {
        entry_count: field(0),
        block_count: field(1),
        data_start: 0,
        data_len: bloom_offset,
        index_start: index_offset,
        index_end: footer,
        crc_off: footer + 28,
    })
}

fn decode_blocks(buf: &[u8], layout: &Layout, with_seq: bool) -> Result<Vec<Entry>, SstError> {
    let Layout { entry_count, block_count, data_start, data_len, index_start, index_end, .. } =
        *layout;
    let mut o = index_start;
    let mut out = Vec::with_capacity(entry_count);
    for _ in 0..block_count {
        if o + 4 > index_end {
            return Err(SstError::Truncated);
        }
        let first_len = read_u32(buf, o) as usize;
        o += 4 + first_len;
        if o + 4 > index_end {
            return Err(SstError::Truncated);
        }
        let last_len = read_u32(buf, o) as usize;
        o += 4 + last_len;
        if o + 8 > index_end {
            return Err(SstError::Truncated);
        }
        let offset = read_u32(buf, o) as usize;
        o += 4;
        let length = read_u32(buf, o) as usize;
        o += 4;

        let start = data_start + offset;
        let end = start + length;
        if end > data_start + data_len {
            return Err(SstError::Truncated);
        }
        let count = read_u32(buf, start) as usize;
        out.extend(read_records(buf, start + 4, end, count, with_seq)?);
    }
    if o != index_end {
        return Err(SstError::TrailingGarbage);
    }
    if out.len() != entry_count {
        return Err(SstError::CountMismatch);
    }
    Ok(out)
}

/// v5 keeps its magic and version in the last 8 bytes. Older versions keep
/// them in the first 8. v2 to v4 end with a block length, which is never 5,
/// then the CRC. A v1 run passes for v5 only if its CRC equals the magic.
fn sst_version(buf: &[u8]) -> Result<u32, SstError> {
    let n = buf.len();
    if n >= FOOTER_BYTES && read_u32(buf, n - 4) == MAGIC && read_u32(buf, n - 8) == VERSION_V5 {
        return Ok(VERSION_V5);
    }
    let magic = read_u32(buf, 0);
    if magic != MAGIC {
        return Err(SstError::BadMagic(magic));
    }
    Ok(read_u32(buf, 4))
}

pub fn decode_sst(buf: &[u8]) -> Result<Vec<Entry>, SstError> {
    if buf.len() < 16 {
        return Err(SstError::TooShort);
    }
    let version = sst_version(buf)?;
    let layout = match version {
        VERSION_V1 => None,
        VERSION_V2 | VERSION_V3 | VERSION_V4 => Some(legacy_layout(buf, version)?),
        VERSION_V5 => Some(v5_layout(buf)?),
        other => return Err(SstError::BadVersion(other)),
    };
    let crc_off = layout.as_ref().map_or(buf.len() - 4, |l| l.crc_off);
    if read_u32(buf, crc_off) != crc32(&buf[..crc_off]) {
        return Err(SstError::CrcMismatch);
    }
    match layout {
        None => decode_v1(buf, crc_off),
        Some(layout) => decode_blocks(buf, &layout, version >= VERSION_V3),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_keeps_seq() {
        let entries = vec![
            Entry::Put { key: b"b".to_vec(), value: b"2".to_vec(), seq: 7 },
            Entry::Del { key: b"a".to_vec(), seq: 9 },
            Entry::Put { key: b"c".to_vec(), value: b"3".to_vec(), seq: 1 << 40 },
        ];
        let bytes = encode_sst(&entries);
        assert_eq!(read_u32(&bytes, bytes.len() - 8), VERSION_V5);
        let decoded = decode_sst(&bytes).unwrap();
        assert_eq!(decoded[0], Entry::Del { key: b"a".to_vec(), seq: 9 });
        assert_eq!(decoded[1], Entry::Put { key: b"b".to_vec(), value: b"2".to_vec(), seq: 7 });
        assert_eq!(decoded[2].seq(), 1 << 40);
    }

    /// Put a=1 at seq 7 and delete b at seq 9, as the v4 encoder wrote them.
    const V4_FIXTURE: &str = "54534c4f0400000002000000010000002500000007000000080000008d008209207040000200000001070000000000000001000000610100000031020900000000000000010000006201000000610100000062000000002500000074971cb3";

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    #[test]
    fn reads_v4() {
        let decoded = decode_sst(&hex(V4_FIXTURE)).unwrap();
        assert_eq!(decoded[0], Entry::Put { key: b"a".to_vec(), value: b"1".to_vec(), seq: 7 });
        assert_eq!(decoded[1], Entry::Del { key: b"b".to_vec(), seq: 9 });
    }

    #[test]
    fn data_comes_first_and_the_footer_last() {
        let entries = vec![Entry::Put { key: b"a".to_vec(), value: b"1".to_vec(), seq: 7 }];
        let bytes = encode_sst(&entries);
        assert_eq!(read_u32(&bytes, 0), 1, "first block's record count");
        assert_eq!(read_u32(&bytes, bytes.len() - 4), MAGIC);
    }

    #[test]
    fn rejects_a_flipped_data_byte() {
        let entries = vec![Entry::Put { key: b"a".to_vec(), value: b"1".to_vec(), seq: 7 }];
        let mut bytes = encode_sst(&entries);
        bytes[5] ^= 0xff;
        assert_eq!(decode_sst(&bytes), Err(SstError::CrcMismatch));
    }

    #[test]
    fn multi_block() {
        let mut entries = Vec::new();
        for i in 0..200 {
            let key = format!("k{i:04}").into_bytes();
            entries.push(Entry::Put { key, value: vec![b'x'; 64], seq: i });
        }
        let bytes = encode_sst(&entries);
        let block_count = read_u32(&bytes, bytes.len() - FOOTER_BYTES + 4);
        assert!(block_count > 1, "expected multiple blocks, got {block_count}");
        let decoded = decode_sst(&bytes).unwrap();
        assert_eq!(decoded.len(), 200);
        assert_eq!(decoded[199].seq(), 199);
    }

    #[test]
    fn bloom_past_64_kib() {
        let entries: Vec<Entry> = (0..60_000u64)
            .map(|i| Entry::Put { key: format!("k{i:08}").into_bytes(), value: b"v".to_vec(), seq: i })
            .collect();
        let bytes = encode_sst(&entries);
        assert!(read_u32(&bytes, bytes.len() - FOOTER_BYTES + 12) > u16::MAX as u32);
        assert_eq!(decode_sst(&bytes).unwrap().len(), 60_000);
    }
}

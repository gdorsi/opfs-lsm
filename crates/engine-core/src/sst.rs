//! SST format — v1 (legacy single-block) decode + v2 (multi-block + Bloom) encode/decode.
//! Must stay byte-compatible with `packages/kv/src/store/sst.ts`.

use crate::bloom::{bloom_add, create_bloom};
use crate::crc32::crc32;

const MAGIC: u32 = 0x4f4c_5354; // OLST
const VERSION_V1: u32 = 1;
const VERSION_V2: u32 = 2;
const TAG_PUT: u8 = 1;
const TAG_DEL: u8 = 2;
const BLOCK_TARGET: usize = 4 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Entry {
    Put { key: Vec<u8>, value: Vec<u8> },
    Del { key: Vec<u8> },
}

impl Entry {
    pub fn key(&self) -> &[u8] {
        match self {
            Entry::Put { key, .. } | Entry::Del { key } => key,
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

fn entry_size(e: &Entry) -> usize {
    let mut n = 1 + 4 + e.key().len();
    if let Entry::Put { value, .. } = e {
        n += 4 + value.len();
    }
    n
}

fn write_u32(buf: &mut [u8], o: &mut usize, v: u32) {
    buf[*o..*o + 4].copy_from_slice(&v.to_le_bytes());
    *o += 4;
}

fn write_u16(buf: &mut [u8], o: &mut usize, v: u16) {
    buf[*o..*o + 2].copy_from_slice(&v.to_le_bytes());
    *o += 2;
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
            Entry::Put { key, value } => {
                out[*o] = TAG_PUT;
                *o += 1;
                write_u32(out, o, key.len() as u32);
                out[*o..*o + key.len()].copy_from_slice(key);
                *o += key.len();
                write_u32(out, o, value.len() as u32);
                out[*o..*o + value.len()].copy_from_slice(value);
                *o += value.len();
            }
            Entry::Del { key } => {
                out[*o] = TAG_DEL;
                *o += 1;
                write_u32(out, o, key.len() as u32);
                out[*o..*o + key.len()].copy_from_slice(key);
                *o += key.len();
            }
        }
    }
}

/// Encode SST v2 (multi-block + Bloom + block index).
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

    let total = 20 + 4 + bloom.bits.len() + data_len + index_size + 4;
    let mut out = vec![0u8; total];
    let mut o = 0usize;
    write_u32(&mut out, &mut o, MAGIC);
    write_u32(&mut out, &mut o, VERSION_V2);
    write_u32(&mut out, &mut o, sorted.len() as u32);
    write_u32(&mut out, &mut o, blocks.len() as u32);
    write_u32(&mut out, &mut o, data_len as u32);
    write_u16(&mut out, &mut o, bloom.hash_count as u16);
    write_u16(&mut out, &mut o, bloom.bits.len() as u16);
    out[o..o + bloom.bits.len()].copy_from_slice(&bloom.bits);
    o += bloom.bits.len();

    for blob in &block_blobs {
        out[o..o + blob.len()].copy_from_slice(blob);
        o += blob.len();
    }

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

    let sum = crc32(&out[..o]);
    write_u32(&mut out, &mut o, sum);
    debug_assert_eq!(o, out.len());
    out
}

fn read_records(
    buf: &[u8],
    mut o: usize,
    end: usize,
    count: usize,
) -> Result<Vec<Entry>, SstError> {
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        if o >= end {
            return Err(SstError::Truncated);
        }
        let tag = buf[o];
        o += 1;
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
                out.push(Entry::Put { key, value });
            }
            TAG_DEL => out.push(Entry::Del { key }),
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
    read_records(buf, 12, crc_off, count)
}

fn decode_v2(buf: &[u8], crc_off: usize) -> Result<Vec<Entry>, SstError> {
    if buf.len() < 28 {
        return Err(SstError::TooShort);
    }
    let entry_count = read_u32(buf, 8) as usize;
    let block_count = read_u32(buf, 12) as usize;
    let data_len = read_u32(buf, 16) as usize;
    let bloom_byte_len = read_u16(buf, 22) as usize;
    let data_start = 24 + bloom_byte_len;
    let index_start = data_start + data_len;
    if index_start > crc_off {
        return Err(SstError::Truncated);
    }

    let mut o = index_start;
    let mut out = Vec::with_capacity(entry_count);
    for _ in 0..block_count {
        if o + 4 > crc_off {
            return Err(SstError::Truncated);
        }
        let first_len = read_u32(buf, o) as usize;
        o += 4 + first_len;
        if o + 4 > crc_off {
            return Err(SstError::Truncated);
        }
        let last_len = read_u32(buf, o) as usize;
        o += 4 + last_len;
        if o + 8 > crc_off {
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
        out.extend(read_records(buf, start + 4, end, count)?);
    }
    if o != crc_off {
        return Err(SstError::TrailingGarbage);
    }
    if out.len() != entry_count {
        return Err(SstError::CountMismatch);
    }
    Ok(out)
}

pub fn decode_sst(buf: &[u8]) -> Result<Vec<Entry>, SstError> {
    if buf.len() < 16 {
        return Err(SstError::TooShort);
    }
    let magic = read_u32(buf, 0);
    if magic != MAGIC {
        return Err(SstError::BadMagic(magic));
    }
    let version = read_u32(buf, 4);
    let crc_off = buf.len() - 4;
    let expect = read_u32(buf, crc_off);
    let actual = crc32(&buf[..crc_off]);
    if expect != actual {
        return Err(SstError::CrcMismatch);
    }
    match version {
        VERSION_V1 => decode_v1(buf, crc_off),
        VERSION_V2 => decode_v2(buf, crc_off),
        other => Err(SstError::BadVersion(other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_v2() {
        let entries = vec![
            Entry::Put {
                key: b"b".to_vec(),
                value: b"2".to_vec(),
            },
            Entry::Del {
                key: b"a".to_vec(),
            },
            Entry::Put {
                key: b"c".to_vec(),
                value: b"3".to_vec(),
            },
        ];
        let bytes = encode_sst(&entries);
        assert_eq!(read_u32(&bytes, 4), VERSION_V2);
        let decoded = decode_sst(&bytes).unwrap();
        assert_eq!(decoded[0], Entry::Del { key: b"a".to_vec() });
        assert_eq!(
            decoded[1],
            Entry::Put {
                key: b"b".to_vec(),
                value: b"2".to_vec()
            }
        );
    }

    #[test]
    fn multi_block() {
        let mut entries = Vec::new();
        for i in 0..200 {
            let key = format!("k{i:04}").into_bytes();
            let value = vec![b'x'; 64];
            entries.push(Entry::Put { key, value });
        }
        let bytes = encode_sst(&entries);
        let block_count = read_u32(&bytes, 12);
        assert!(block_count > 1, "expected multiple blocks, got {block_count}");
        let decoded = decode_sst(&bytes).unwrap();
        assert_eq!(decoded.len(), 200);
    }
}

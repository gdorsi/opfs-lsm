//! SST format. v1 (single block) and v2 (multi-block + Bloom) decode. v3 is
//! v2 with a u64 seq after each record tag. v4 is v3 with u32 Bloom header
//! fields, so a filter can pass 64 KiB. v5 is v4's sections with the Bloom
//! filter and index after the data, and a fixed footer at the end. v6 is v5
//! with a codec field in the footer, so data blocks can be LZ4-compressed.
//! v7 is what encode writes: v6 with each block's common key prefix stored
//! once and varint lengths in its records.
//! Must stay byte-compatible with `packages/kv/src/store/sst.ts`.

use crate::bloom::{bloom_add, create_bloom};
use crate::crc32::crc32;

const MAGIC: u32 = 0x4f4c_5354; // OLST
const VERSION_V1: u32 = 1;
const VERSION_V2: u32 = 2;
const VERSION_V3: u32 = 3;
const VERSION_V4: u32 = 4;
const VERSION_V5: u32 = 5;
const VERSION_V6: u32 = 6;
const VERSION_V7: u32 = 7;
const FOOTER_V5: usize = 40;
const FOOTER_BYTES: usize = 44;
const TAG_PUT: u8 = 1;
const TAG_DEL: u8 = 2;
const BLOCK_TARGET: usize = 4 * 1024;
/// A v7 block stores the offset of every `OFFSET_STRIDE`th record after
/// the first, so a get binary-searches them and walks at most
/// `OFFSET_STRIDE - 1` records. `packages/kv/src/store/sst.ts` uses the
/// same stride.
const OFFSET_STRIDE: usize = 4;

const _: () = assert!(BLOCK_TARGET <= u16::MAX as usize, "a block's offsets are u16");

/// Bytes of a v7 block's offset table: a u16 per sampled record. Only a
/// block of one record can pass the u16 range, and it has no table.
fn offset_table_bytes(count: usize) -> usize {
    2 * (count.saturating_sub(1) / OFFSET_STRIDE)
}

/// How a run stores its data blocks. An LZ4 block is a u32 uncompressed
/// length followed by the LZ4 block-format bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Codec {
    Raw = 0,
    Lz4 = 1,
}

impl Codec {
    fn from_u32(v: u32) -> Result<Codec, SstError> {
        match v {
            0 => Ok(Codec::Raw),
            1 => Ok(Codec::Lz4),
            other => Err(SstError::BadCodec(other)),
        }
    }
}

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
    BadCodec(u32),
    BadBlock,
}

impl std::fmt::Display for SstError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for SstError {}

/// An entry's size as a v6 record. v7 records are never larger, so
/// compaction uses it to cut runs without encoding them.
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

/// Unsigned LEB128 of at most 5 bytes, so it fits a u32.
fn read_varint(buf: &[u8], o: &mut usize, end: usize) -> Result<usize, SstError> {
    let mut v = 0usize;
    for shift in (0..35).step_by(7) {
        if *o >= end {
            return Err(SstError::Truncated);
        }
        let b = buf[*o];
        *o += 1;
        v |= ((b & 0x7f) as usize) << shift;
        if b < 0x80 {
            return if v > u32::MAX as usize { Err(SstError::BadBlock) } else { Ok(v) };
        }
    }
    Err(SstError::BadBlock)
}

fn common_prefix(a: &[u8], b: &[u8]) -> usize {
    a.iter().zip(b).take_while(|(x, y)| x == y).count()
}

/// A v7 record's bytes besides its key suffix. The suffix length varint is
/// sized from the whole key, an upper bound that stays fixed as the
/// block prefix shrinks, so a block is sized from running sums.
/// `packages/kv/src/store/sst.ts` sizes blocks the same way.
fn record_overhead(e: &Entry) -> usize {
    let n = 1 + 8 + varint_len(e.key().len());
    match e {
        Entry::Put { value, .. } => n + varint_len(value.len()) + value.len(),
        Entry::Del { .. } => n,
    }
}

/// Cut sorted entries into blocks of at most `BLOCK_TARGET` v7 bytes, or one
/// entry. A block's prefix shrinks as keys join it, so its size is
/// recomputed from running key and overhead sums at each entry.
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

/// One v7 data block before compression:
///   u32 count | varint prefixLen | prefix | count records | u16 offsets
/// The prefix is the longest one shared by every key in the block, which
/// for sorted keys is the first and last key's. `offsets[j]` is where
/// record `(j + 1) * OFFSET_STRIDE` starts, from the start of the block.
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

/// u8 tag | u64 seq | varint suffixLen | suffix | (put) varint valLen | value
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

/// Encode SST v7:
///   data blocks | bloom bits | block index | footer (44 bytes)
/// The footer is u32 entry count, block count, bloom offset, bloom length,
/// bloom hash count, index offset, index length, codec, then a u32 CRC of
/// every byte before it, u32 version 7 and u32 magic.
pub fn encode_sst(entries: &[Entry], codec: Codec) -> Vec<u8> {
    let mut sorted: Vec<&Entry> = entries.iter().collect();
    sorted.sort_by(|a, b| a.key().cmp(b.key()));

    let blocks = split_blocks(&sorted);

    let mut bloom = create_bloom(sorted.len().max(1), 10);
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
    write_u32(&mut out, &mut o, VERSION_V7);
    write_u32(&mut out, &mut o, MAGIC);
    debug_assert_eq!(o, out.len());
    out
}

/// How a version lays out its records. v1 and v2 have no seq. v3 to v6
/// have a u64 seq and u32 lengths. v7 has a u64 seq, varint lengths, and a
/// key prefix shared by the block, so a record holds only the key's suffix.
#[derive(Clone, Copy)]
struct RecordFormat {
    seq: bool,
    prefixed: bool,
}

impl RecordFormat {
    fn of(version: u32) -> RecordFormat {
        RecordFormat { seq: version >= VERSION_V3, prefixed: version >= VERSION_V7 }
    }

    fn read_len(self, buf: &[u8], o: &mut usize, end: usize) -> Result<usize, SstError> {
        if self.prefixed {
            return read_varint(buf, o, end);
        }
        if *o + 4 > end {
            return Err(SstError::Truncated);
        }
        let v = read_u32(buf, *o) as usize;
        *o += 4;
        Ok(v)
    }
}

/// `count` records in `buf[o..end]`, each key after `prefix`.
fn read_records(
    buf: &[u8],
    mut o: usize,
    end: usize,
    count: usize,
    fmt: RecordFormat,
    prefix: &[u8],
) -> Result<Vec<Entry>, SstError> {
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        if o >= end {
            return Err(SstError::Truncated);
        }
        let tag = buf[o];
        o += 1;
        let mut seq = 0u64;
        if fmt.seq {
            if o + 8 > end {
                return Err(SstError::Truncated);
            }
            seq = u64::from_le_bytes(buf[o..o + 8].try_into().unwrap());
            o += 8;
        }
        let key_len = fmt.read_len(buf, &mut o, end)?;
        if o + key_len > end {
            return Err(SstError::Truncated);
        }
        let mut key = Vec::with_capacity(prefix.len() + key_len);
        key.extend_from_slice(prefix);
        key.extend_from_slice(&buf[o..o + key_len]);
        o += key_len;
        match tag {
            TAG_PUT => {
                let val_len = fmt.read_len(buf, &mut o, end)?;
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

/// One unpacked data block: u32 count, then for v7 a varint prefix length
/// and the prefix, then the records, then v7's offset table, which a full
/// decode skips.
fn read_block(block: &[u8], fmt: RecordFormat) -> Result<Vec<Entry>, SstError> {
    if block.len() < 4 {
        return Err(SstError::Truncated);
    }
    let count = read_u32(block, 0) as usize;
    let mut o = 4;
    let mut end = block.len();
    let mut prefix: &[u8] = &[];
    if fmt.prefixed {
        end = end.checked_sub(offset_table_bytes(count)).ok_or(SstError::Truncated)?;
        let p = read_varint(block, &mut o, end)?;
        if o + p > end {
            return Err(SstError::Truncated);
        }
        prefix = &block[o..o + p];
        o += p;
    }
    read_records(block, o, end, count, fmt, prefix)
}

fn decode_v1(buf: &[u8], crc_off: usize) -> Result<Vec<Entry>, SstError> {
    let count = read_u32(buf, 8) as usize;
    read_records(buf, 12, crc_off, count, RecordFormat::of(VERSION_V1), &[])
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
    codec: Codec,
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
        codec: Codec::Raw,
    })
}

/// v5 to v7 share a footer. v6 adds the codec field after the index length.
fn footer_layout(buf: &[u8], version: u32) -> Result<Layout, SstError> {
    let fields = if version >= VERSION_V6 { 8 } else { 7 };
    let footer = buf.len() - (fields + 3) * 4;
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
        crc_off: footer + 4 * fields,
        codec: if fields == 8 { Codec::from_u32(field(7) as u32)? } else { Codec::Raw },
    })
}

fn decode_blocks(buf: &[u8], layout: &Layout, fmt: RecordFormat) -> Result<Vec<Entry>, SstError> {
    let Layout { entry_count, block_count, data_start, data_len, index_start, index_end, codec, .. } =
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
        let unpacked;
        let block = match codec {
            Codec::Raw => &buf[start..end],
            Codec::Lz4 => {
                if length < 4 {
                    return Err(SstError::Truncated);
                }
                let size = read_u32(buf, start) as usize;
                unpacked = lz4_flex::block::decompress(&buf[start + 4..end], size)
                    .map_err(|_| SstError::BadBlock)?;
                if unpacked.len() != size {
                    return Err(SstError::BadBlock);
                }
                &unpacked[..]
            }
        };
        out.extend(read_block(block, fmt)?);
    }
    if o != index_end {
        return Err(SstError::TrailingGarbage);
    }
    if out.len() != entry_count {
        return Err(SstError::CountMismatch);
    }
    Ok(out)
}

/// v5 to v7 keep their magic and version in the last 8 bytes. Older
/// versions keep them in the first 8. v2 to v4 end with a block length,
/// which is 4 or at least 9, then the CRC. A v1 run passes for v5 to v7
/// only if its CRC equals the magic.
fn sst_version(buf: &[u8]) -> Result<u32, SstError> {
    let n = buf.len();
    if n >= FOOTER_V5 && read_u32(buf, n - 4) == MAGIC {
        let version = read_u32(buf, n - 8);
        let footer = if version >= VERSION_V6 { FOOTER_BYTES } else { FOOTER_V5 };
        if (VERSION_V5..=VERSION_V7).contains(&version) && n >= footer {
            return Ok(version);
        }
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
        VERSION_V5 | VERSION_V6 | VERSION_V7 => Some(footer_layout(buf, version)?),
        other => return Err(SstError::BadVersion(other)),
    };
    let crc_off = layout.as_ref().map_or(buf.len() - 4, |l| l.crc_off);
    if read_u32(buf, crc_off) != crc32(&buf[..crc_off]) {
        return Err(SstError::CrcMismatch);
    }
    match layout {
        None => decode_v1(buf, crc_off),
        Some(layout) => decode_blocks(buf, &layout, RecordFormat::of(version)),
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
        let bytes = encode_sst(&entries, Codec::Raw);
        assert_eq!(read_u32(&bytes, bytes.len() - 8), VERSION_V7);
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

    /// The same two entries, as the v5 encoder wrote them, before the footer had a codec.
    const V5_FIXTURE: &str = "020000000107000000000000000100000061010000003102090000000000000001000000628d0082092070400001000000610100000062000000002500000002000000010000002500000008000000070000002d00000012000000ee9a880b0500000054534c4f";

    #[test]
    fn reads_v5() {
        let decoded = decode_sst(&hex(V5_FIXTURE)).unwrap();
        assert_eq!(decoded[0], Entry::Put { key: b"a".to_vec(), value: b"1".to_vec(), seq: 7 });
        assert_eq!(decoded[1], Entry::Del { key: b"b".to_vec(), seq: 9 });
    }

    /// The same two entries, as the v6 encoder wrote them, with u32 lengths and whole keys.
    const V6_FIXTURE: &str = "020000000107000000000000000100000061010000003102090000000000000001000000628d0082092070400001000000610100000062000000002500000002000000010000002500000008000000070000002d0000001200000000000000fa1fe8830600000054534c4f";

    #[test]
    fn reads_v6() {
        let decoded = decode_sst(&hex(V6_FIXTURE)).unwrap();
        assert_eq!(decoded[0], Entry::Put { key: b"a".to_vec(), value: b"1".to_vec(), seq: 7 });
        assert_eq!(decoded[1], Entry::Del { key: b"b".to_vec(), seq: 9 });
    }

    fn put(key: &[u8], value: &[u8], seq: u64) -> Entry {
        Entry::Put { key: key.to_vec(), value: value.to_vec(), seq }
    }

    fn round_trip(entries: Vec<Entry>) {
        let mut sorted = entries.clone();
        sorted.sort_by(|a, b| a.key().cmp(b.key()));
        for codec in [Codec::Raw, Codec::Lz4] {
            assert_eq!(decode_sst(&encode_sst(&entries, codec)).unwrap(), sorted, "{codec:?}");
        }
    }

    #[test]
    fn round_trips_edge_shapes() {
        round_trip(vec![]);
        round_trip(vec![put(b"only", b"v", 1)]);
        round_trip(vec![put(b"", b"empty key", 1), put(b"a", b"", 2), Entry::Del { key: b"ab".to_vec(), seq: 3 }]);
        round_trip(vec![put(b"apple", b"1", 1), put(b"zebra", b"2", 2), put(b"mango", b"3", 3)]);
        round_trip(vec![put(&[0xff; 300], &[7; 200], 1), put(&[0xff; 301], b"", u64::MAX)]);
    }

    /// Index keys as collections writes them: a long head every key shares.
    fn index_rows(n: u64) -> Vec<Entry> {
        (0..n)
            .map(|i| put(format!("i/\x05\0todos\x09\0byCreated{:016x}{i:08}", 1_700_000 + i / 3).as_bytes(), b"", i))
            .collect()
    }

    #[test]
    fn a_block_stores_its_shared_prefix_once() {
        let entries = index_rows(1);
        let key = entries[0].key().to_vec();
        let bytes = encode_sst(&entries, Codec::Raw);
        assert_eq!(bytes[4] as usize, key.len(), "prefix length varint");
        assert_eq!(&bytes[5..5 + key.len()], &key[..], "a lone key is all prefix");
        assert_eq!(&bytes[5 + key.len()..5 + key.len() + 11], &[TAG_PUT, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

        let many = index_rows(3_000);
        let bytes = encode_sst(&many, Codec::Raw);
        let raw: usize = many.iter().map(entry_size).sum();
        assert!(bytes.len() * 2 < raw, "{} vs {raw} record bytes", bytes.len());
        assert_eq!(decode_sst(&bytes).unwrap(), many);
    }

    #[test]
    fn blocks_fill_to_the_target_in_encoded_bytes() {
        let bytes = encode_sst(&index_rows(3_000), Codec::Raw);
        let footer = bytes.len() - FOOTER_BYTES;
        let (blocks, data_len) = (read_u32(&bytes, footer + 4) as usize, read_u32(&bytes, footer + 8) as usize);
        assert!(blocks > 1);
        assert!(data_len / blocks > BLOCK_TARGET * 9 / 10, "{} bytes per block", data_len / blocks);
        assert!(data_len / blocks <= BLOCK_TARGET);
    }

    #[test]
    fn offsets_point_at_every_stride_th_record() {
        let entries = index_rows(3_000);
        let bytes = encode_sst(&entries, Codec::Raw);
        let index_start = read_u32(&bytes, bytes.len() - FOOTER_BYTES + 4 * 5) as usize;
        let o = index_start + 4 + read_u32(&bytes, index_start) as usize;
        let length = read_u32(&bytes, o + 4 + read_u32(&bytes, o) as usize + 4) as usize;
        let block = &bytes[..length];
        let count = read_u32(block, 0) as usize;
        assert!(count > OFFSET_STRIDE, "{count} records");
        let table = length - offset_table_bytes(count);
        let p = block[4] as usize;
        let records = read_records(block, 5 + p, table, count, RecordFormat::of(VERSION_V7), &block[5..5 + p]).unwrap();
        for j in 1..=(count - 1) / OFFSET_STRIDE {
            let at = read_u16(block, table + 2 * (j - 1)) as usize;
            let one = read_records(block, at, table, count - j * OFFSET_STRIDE, RecordFormat::of(VERSION_V7), &block[5..5 + p]).unwrap();
            assert_eq!(one[0], records[j * OFFSET_STRIDE], "offset {j}");
        }
    }

    #[test]
    fn a_record_past_u16_offsets_gets_a_block_of_its_own() {
        let big = vec![7u8; 70_000];
        round_trip(vec![put(b"a", b"1", 1), put(b"b", &big, 2), put(b"c", b"3", 3)]);
        let bytes = encode_sst(&[put(b"a", b"1", 1), put(b"b", &big, 2), put(b"c", b"3", 3)], Codec::Raw);
        assert_eq!(read_u32(&bytes, bytes.len() - FOOTER_BYTES + 4), 3, "one block per entry");
    }

    #[test]
    fn rejects_an_overlong_varint() {
        let mut bytes = encode_sst(&[put(b"a", b"1", 7)], Codec::Raw);
        bytes[4..10].fill(0xff);
        let crc_off = bytes.len() - 12;
        let sum = crc32(&bytes[..crc_off]);
        bytes[crc_off..crc_off + 4].copy_from_slice(&sum.to_le_bytes());
        assert!(decode_sst(&bytes).is_err());
    }

    fn todo_rows(n: u64) -> Vec<Entry> {
        (0..n)
            .map(|i| Entry::Put {
                key: format!("todo/{i:013}").into_bytes(),
                value: format!("{{\"title\":\"buy milk {}\",\"done\":false}}", i % 7).into_bytes(),
                seq: i,
            })
            .collect()
    }

    #[test]
    fn lz4_round_trips_and_shrinks_the_run() {
        let entries = todo_rows(2_000);
        let raw = encode_sst(&entries, Codec::Raw);
        let packed = encode_sst(&entries, Codec::Lz4);
        assert_eq!(read_u32(&packed, packed.len() - 16), Codec::Lz4 as u32);
        assert!(packed.len() * 2 < raw.len(), "{} vs {}", packed.len(), raw.len());
        assert_eq!(decode_sst(&packed).unwrap(), decode_sst(&raw).unwrap());
    }

    #[test]
    fn lz4_round_trips_an_empty_run() {
        assert_eq!(decode_sst(&encode_sst(&[], Codec::Lz4)).unwrap(), vec![]);
    }

    #[test]
    fn rejects_a_corrupt_lz4_block_even_with_a_matching_crc() {
        let mut bytes = encode_sst(&todo_rows(200), Codec::Lz4);
        for b in &mut bytes[4..40] {
            *b = 0xff;
        }
        let crc_off = bytes.len() - 12;
        let sum = crc32(&bytes[..crc_off]);
        bytes[crc_off..crc_off + 4].copy_from_slice(&sum.to_le_bytes());
        assert!(decode_sst(&bytes).is_err());
    }

    #[test]
    fn rejects_an_unknown_codec() {
        let mut bytes = encode_sst(&todo_rows(3), Codec::Raw);
        let at = bytes.len() - 16;
        bytes[at] = 9;
        let crc_off = bytes.len() - 12;
        let sum = crc32(&bytes[..crc_off]);
        bytes[crc_off..crc_off + 4].copy_from_slice(&sum.to_le_bytes());
        assert_eq!(decode_sst(&bytes), Err(SstError::BadCodec(9)));
    }

    #[test]
    fn data_comes_first_and_the_footer_last() {
        let entries = vec![Entry::Put { key: b"a".to_vec(), value: b"1".to_vec(), seq: 7 }];
        let bytes = encode_sst(&entries, Codec::Raw);
        assert_eq!(read_u32(&bytes, 0), 1, "first block's record count");
        assert_eq!(read_u32(&bytes, bytes.len() - 4), MAGIC);
    }

    #[test]
    fn rejects_a_flipped_data_byte() {
        let entries = vec![Entry::Put { key: b"a".to_vec(), value: b"1".to_vec(), seq: 7 }];
        let mut bytes = encode_sst(&entries, Codec::Raw);
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
        let bytes = encode_sst(&entries, Codec::Raw);
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
        let bytes = encode_sst(&entries, Codec::Raw);
        assert!(read_u32(&bytes, bytes.len() - FOOTER_BYTES + 12) > u16::MAX as u32);
        assert_eq!(decode_sst(&bytes).unwrap().len(), 60_000);
    }
}

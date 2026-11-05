import { compareBytes } from "../bytes.js";
import { CorruptDatabaseError } from "../errors.js";
import {
  entryCursor,
  lowerBoundKeys,
  type LayerCursor,
  type ScanBounds,
} from "./cursor.js";
import {
  bloomAdd,
  bloomMightContain,
  createBloom,
  type BloomFilter,
} from "./bloom.js";
import { crc32 } from "./crc32.js";
import { lz4Decompress } from "./lz4.js";

/** Magic ASCII "OLST" (opfs-lsm SST). */
export const SST_MAGIC = 0x4f4c5354;
const VERSION_V1 = 1;
const VERSION_V2 = 2;
/** v2 layout, with a u64 seq after each record's tag. */
const VERSION_V3 = 3;
/** v3 with u32 Bloom header fields, so a filter can pass 64 KiB. */
const VERSION_V4 = 4;
/** v4's sections with the Bloom filter and index after the data and a fixed footer. */
const VERSION_V5 = 5;
/** v5 with a codec field in the footer. */
const VERSION_V6 = 6;
/** v6 with each block's common key prefix stored once and varint record lengths. */
const VERSION_V7 = 7;
const FOOTER_V5 = 40;
const FOOTER_BYTES = 44;

/**
 * How a run stores its data blocks. An LZ4 block is a u32 uncompressed
 * length followed by LZ4 block-format bytes.
 */
export type SstCodec = "raw" | "lz4";
const CODECS: readonly SstCodec[] = ["raw", "lz4"];

function isBlockVersion(version: number): boolean {
  return version >= VERSION_V2 && version <= VERSION_V7;
}

/**
 * v5 to v7 keep their magic and version in the last 8 bytes. Older
 * versions keep them in the first 8. v2 to v4 end with a block length,
 * which is 4 or at least 9, then the CRC. A v1 run passes for v5 to v7
 * only if its CRC equals the magic.
 */
function sstVersion(buf: Uint8Array, view: DataView): number {
  const n = buf.byteLength;
  if (n >= FOOTER_V5 && view.getUint32(n - 4, true) === SST_MAGIC) {
    const version = view.getUint32(n - 8, true);
    const footer = version >= VERSION_V6 ? FOOTER_BYTES : FOOTER_V5;
    if (version >= VERSION_V5 && version <= VERSION_V7 && n >= footer) return version;
  }
  const magic = view.getUint32(0, true);
  if (magic !== SST_MAGIC) {
    throw new CorruptDatabaseError(`bad sst magic ${magic.toString(16)}`);
  }
  return view.getUint32(4, true);
}
const TAG_PUT = 1;
const TAG_DEL = 2;

/** Target encoded size per data block (v2). */
export const SST_BLOCK_TARGET = 4 * 1024;

/**
 * A v7 block stores the offset of every `OFFSET_STRIDE`th record after
 * the first, so a get binary-searches them and walks at most
 * `OFFSET_STRIDE - 1` records. `crates/engine-core/src/sst.rs` uses the
 * same stride.
 */
export const OFFSET_STRIDE = 4;

/**
 * Bytes of a v7 block's offset table: a u16 per sampled record. Only a
 * block of one record can pass the u16 range, and it has no table.
 */
function offsetTableBytes(count: number): number {
  return count > 1 ? 2 * Math.floor((count - 1) / OFFSET_STRIDE) : 0;
}

/** `seq` is the WAL seq that wrote the entry. Runs older than v3 read as 0. */
export type SstEntry =
  | {
      readonly kind: "put";
      readonly key: Uint8Array;
      readonly value: Uint8Array;
      readonly seq?: number;
    }
  | { readonly kind: "del"; readonly key: Uint8Array; readonly seq?: number };

type BlockIndexEntry = {
  firstKey: Uint8Array;
  lastKey: Uint8Array;
  offset: number;
  length: number;
};

/**
 * An entry's size as a v6 record. v7 records are never larger, so runs are
 * cut by it without encoding them.
 */
export function entryRecordSize(e: SstEntry): number {
  let n = 1 + 8 + 4 + e.key.byteLength;
  if (e.kind === "put") n += 4 + e.value.byteLength;
  return n;
}

function varintLen(v: number): number {
  let n = 1;
  while (v >= 0x80) {
    v = Math.floor(v / 0x80);
    n++;
  }
  return n;
}

function writeVarint(out: Uint8Array, o: number, v: number): number {
  while (v >= 0x80) {
    out[o++] = (v & 0x7f) | 0x80;
    v = Math.floor(v / 0x80);
  }
  out[o++] = v;
  return o;
}

function commonPrefix(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.byteLength, b.byteLength);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/**
 * A v7 record's bytes besides its key suffix. The suffix length varint is
 * sized from the whole key, an upper bound that stays fixed as the
 * block prefix shrinks, so a block is sized from running sums.
 * `crates/engine-core/src/sst.rs` sizes blocks the same way.
 */
function recordOverhead(e: SstEntry): number {
  const n = 1 + 8 + varintLen(e.key.byteLength);
  return e.kind === "put" ? n + varintLen(e.value.byteLength) + e.value.byteLength : n;
}

/**
 * Cut sorted entries into blocks of at most `target` v7 bytes, or one
 * entry. A block's prefix shrinks as keys join it, so its size is
 * recomputed from running key and overhead sums at each entry.
 */
function splitBlocks(sorted: readonly SstEntry[], target: number): SstEntry[][] {
  const blocks: SstEntry[][] = [];
  let start = 0;
  let keys = 0;
  let overhead = 0;
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i]!;
    if (i > start) {
      const p = commonPrefix(sorted[start]!.key, e.key);
      const n = i + 1 - start;
      const size =
        4 + varintLen(p) + p + overhead + recordOverhead(e) + keys + e.key.byteLength - n * p + offsetTableBytes(n);
      if (size > target) {
        blocks.push(sorted.slice(start, i));
        start = i;
        keys = 0;
        overhead = 0;
      }
    }
    keys += e.key.byteLength;
    overhead += recordOverhead(e);
  }
  if (start < sorted.length || blocks.length === 0) blocks.push(sorted.slice(start));
  return blocks;
}

/**
 * One v7 data block before compression:
 *   u32 count | varint prefixLen | prefix | count records | u16 offsets
 * The prefix is the longest one shared by every key in the block, which
 * for sorted keys is the first and last key's. `offsets[j]` is where
 * record `(j + 1) * OFFSET_STRIDE` starts, from the start of the block.
 */
function encodeBlock(block: readonly SstEntry[]): Uint8Array {
  const first = block[0]?.key;
  const p = first ? commonPrefix(first, block[block.length - 1]!.key) : 0;
  let size = 4 + varintLen(p) + p + offsetTableBytes(block.length);
  for (const e of block) {
    const s = e.key.byteLength - p;
    size += 1 + 8 + varintLen(s) + s;
    if (e.kind === "put") size += varintLen(e.value.byteLength) + e.value.byteLength;
  }
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setUint32(0, block.length, true);
  let o = writeVarint(out, 4, p);
  if (first) out.set(first.subarray(0, p), o);
  o += p;
  let table = size - offsetTableBytes(block.length);
  for (let i = 0; i < block.length; i++) {
    if (i > 0 && i % OFFSET_STRIDE === 0) {
      view.setUint16(table, o, true);
      table += 2;
    }
    o = writeRecord(out, view, o, block[i]!, p);
  }
  return out;
}

/** u8 tag | u64 seq | varint suffixLen | suffix | (put) varint valLen | value */
function writeRecord(out: Uint8Array, view: DataView, o: number, e: SstEntry, prefixLen: number): number {
  out[o++] = e.kind === "put" ? TAG_PUT : TAG_DEL;
  view.setBigUint64(o, BigInt(e.seq ?? 0), true);
  o = writeVarint(out, o + 8, e.key.byteLength - prefixLen);
  out.set(e.key.subarray(prefixLen), o);
  o += e.key.byteLength - prefixLen;
  if (e.kind === "put") {
    o = writeVarint(out, o, e.value.byteLength);
    out.set(e.value, o);
    o += e.value.byteLength;
  }
  return o;
}

/**
 * How a version lays out its records. v1 and v2 have no seq. v3 to v6 have
 * a u64 seq and u32 lengths. v7 has a u64 seq, varint lengths, and a key
 * prefix shared by the block, so a record holds only the key's suffix.
 */
type RecordFormat = { readonly seq: boolean; readonly prefixed: boolean };
const FORMAT_V1: RecordFormat = { seq: false, prefixed: false };
const FORMAT_V3: RecordFormat = { seq: true, prefixed: false };
const FORMAT_V7: RecordFormat = { seq: true, prefixed: true };

function recordFormat(version: number): RecordFormat {
  if (version >= VERSION_V7) return FORMAT_V7;
  return version >= VERSION_V3 ? FORMAT_V3 : FORMAT_V1;
}

/**
 * Walks the records of one block in place. `next` reads the record at `o`
 * into the fields, so a reader copies out only what it keeps. Keys are the
 * block's `prefixLen` bytes at `prefixAt`, then the record's suffix.
 */
class RecordWalker {
  tag = 0;
  seqAt = 0;
  keyAt = 0;
  keyLen = 0;
  valAt = 0;
  valLen = 0;
  private readonly seqBytes: number;
  private readonly varint: boolean;

  constructor(
    readonly fmt: RecordFormat,
    readonly buf: Uint8Array,
    readonly view: DataView,
    public o: number,
    readonly end: number,
    readonly count: number,
    readonly prefixAt: number,
    readonly prefixLen: number,
  ) {
    this.seqBytes = fmt.seq ? 8 : 0;
    this.varint = fmt.prefixed;
  }

  /**
   * One unpacked block: u32 count, then for v7 a varint prefix length and
   * the prefix. A v7 walker's `end` is where the offset table starts.
   */
  static ofBlock(b: BlockBytes, fmt: RecordFormat): RecordWalker {
    const count = b.view.getUint32(b.start, true);
    const w = new RecordWalker(fmt, b.buf, b.view, b.start + 4, b.end, count, 0, 0);
    if (!fmt.prefixed) return w;
    const p = w.len();
    const end = b.end - offsetTableBytes(count);
    if (w.o + p > end) throw new CorruptDatabaseError("sst prefix OOB");
    return new RecordWalker(fmt, b.buf, b.view, w.o + p, end, count, w.o, p);
  }

  /** Reads the record at `o`. Gets walk a block with this, so lengths under 128 skip `len`. */
  next(): void {
    const buf = this.buf;
    let o = this.o;
    if (o >= this.end) throw new CorruptDatabaseError("sst truncated");
    const tag = buf[o]!;
    this.seqAt = o + 1;
    o += 1 + this.seqBytes;
    let n = buf[o]!;
    if (this.varint && n < 0x80) o++;
    else {
      this.o = o;
      n = this.len();
      o = this.o;
    }
    this.keyAt = o;
    this.keyLen = n;
    o += n;
    if (tag === TAG_PUT) {
      n = buf[o]!;
      if (this.varint && n < 0x80) o++;
      else {
        this.o = o;
        n = this.len();
        o = this.o;
      }
      this.valAt = o;
      this.valLen = n;
      o += n;
    } else if (tag === TAG_DEL) {
      this.valLen = 0;
    } else {
      throw new CorruptDatabaseError(`bad sst tag ${tag}`);
    }
    if (o > this.end) throw new CorruptDatabaseError("sst record OOB");
    this.tag = tag;
    this.o = o;
  }

  seq(): number {
    return this.seqBytes ? Number(this.view.getBigUint64(this.seqAt, true)) : 0;
  }

  key(): Uint8Array {
    const { buf, prefixLen, keyAt, keyLen } = this;
    if (prefixLen === 0) return buf.slice(keyAt, keyAt + keyLen);
    // A byte loop beats two subarray views and set() for keys this short.
    const k = new Uint8Array(prefixLen + keyLen);
    const prefixAt = this.prefixAt;
    for (let i = 0; i < prefixLen; i++) k[i] = buf[prefixAt + i]!;
    for (let i = 0; i < keyLen; i++) k[prefixLen + i] = buf[keyAt + i]!;
    return k;
  }

  entry(): SstEntry {
    const key = this.key();
    const seq = this.seq();
    return this.tag === TAG_PUT
      ? { kind: "put", key, value: this.buf.slice(this.valAt, this.valAt + this.valLen), seq }
      : { kind: "del", key, seq };
  }

  /** Every remaining record, checking the block holds nothing after them. */
  entries(): SstEntry[] {
    const out: SstEntry[] = new Array(this.count);
    for (let i = 0; i < this.count; i++) {
      this.next();
      out[i] = this.entry();
    }
    if (this.o !== this.end) throw new CorruptDatabaseError("sst block trailing");
    return out;
  }

  private len(): number {
    const { buf, end } = this;
    if (!this.varint) {
      if (this.o + 4 > end) throw new CorruptDatabaseError("sst truncated");
      const v = this.view.getUint32(this.o, true);
      this.o += 4;
      return v;
    }
    let v = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      if (this.o >= end) throw new CorruptDatabaseError("sst truncated");
      const b = buf[this.o++]!;
      v += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) {
        if (v > 0xffffffff) break;
        return v;
      }
    }
    throw new CorruptDatabaseError("sst bad varint");
  }
}

/**
 * Encode SST v7 with raw blocks. LZ4 blocks come only from the wasm encoder.
 *   data blocks (see `encodeBlock`)
 *   bloom bits
 *   index (each: u32 firstLen|key | u32 lastLen|key | u32 offset | u32 length)
 *   footer, 44 bytes:
 *     u32 entryCount | u32 blockCount | u32 bloomOffset | u32 bloomLen
 *     u32 bloomHashCount | u32 indexOffset | u32 indexLen | u32 codec
 *     u32 crc32 of every byte before it | u32 version=7 | u32 magic
 */
export function encodeSst(
  entries: readonly SstEntry[],
  blockTarget = SST_BLOCK_TARGET,
): Uint8Array {
  if (blockTarget > 0xffff) throw new RangeError("a block's offsets are u16, so its target must fit one");
  const sorted = [...entries].sort((a, b) => compareBytes(a.key, b.key));
  const blocks = splitBlocks(sorted, blockTarget);

  const bloom = createBloom(Math.max(1, sorted.length));
  for (const e of sorted) bloomAdd(bloom, e.key);

  const blockBlobs: Uint8Array[] = [];
  const index: BlockIndexEntry[] = [];
  let dataLen = 0;
  for (const block of blocks) {
    const blob = encodeBlock(block);
    index.push({
      firstKey: block[0]?.key ?? new Uint8Array(0),
      lastKey: block[block.length - 1]?.key ?? new Uint8Array(0),
      offset: dataLen,
      length: blob.byteLength,
    });
    blockBlobs.push(blob);
    dataLen += blob.byteLength;
  }

  let indexSize = 0;
  for (const ix of index) {
    indexSize += 4 + ix.firstKey.byteLength + 4 + ix.lastKey.byteLength + 8;
  }

  const out = new Uint8Array(dataLen + bloom.bits.byteLength + indexSize + FOOTER_BYTES);
  const view = new DataView(out.buffer);
  let o = 0;
  for (const blob of blockBlobs) {
    out.set(blob, o);
    o += blob.byteLength;
  }
  out.set(bloom.bits, o);
  o += bloom.bits.byteLength;

  const indexOffset = o;
  for (const ix of index) {
    view.setUint32(o, ix.firstKey.byteLength, true);
    o += 4;
    out.set(ix.firstKey, o);
    o += ix.firstKey.byteLength;
    view.setUint32(o, ix.lastKey.byteLength, true);
    o += 4;
    out.set(ix.lastKey, o);
    o += ix.lastKey.byteLength;
    view.setUint32(o, ix.offset, true);
    o += 4;
    view.setUint32(o, ix.length, true);
    o += 4;
  }

  for (const field of [
    sorted.length,
    blocks.length,
    dataLen,
    bloom.bits.byteLength,
    bloom.hashCount,
    indexOffset,
    indexSize,
    CODECS.indexOf("raw"),
  ]) {
    view.setUint32(o, field, true);
    o += 4;
  }
  view.setUint32(o, crc32(out.subarray(0, o)), true);
  view.setUint32(o + 4, VERSION_V7, true);
  view.setUint32(o + 8, SST_MAGIC, true);
  return out;
}

function decodeSstV1(buf: Uint8Array, view: DataView, crcOff: number): SstEntry[] {
  return new RecordWalker(FORMAT_V1, buf, view, 12, crcOff, view.getUint32(8, true), 0, 0).entries();
}

type BlockLayout = {
  view: DataView;
  /** Where the CRC is stored. It covers every byte before it. */
  crcOff: number;
  entryCount: number;
  blockCount: number;
  dataLen: number;
  bloom: BloomFilter;
  dataStart: number;
  indexStart: number;
  indexEnd: number;
  codec: SstCodec;
};

function parseBlockLayout(buf: Uint8Array, version: number): BlockLayout {
  if (version >= VERSION_V5) return parseFooterLayout(buf, version);
  if (buf.byteLength < 32) throw new CorruptDatabaseError("sst v2 too short");
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const crcOff = buf.byteLength - 4;
  const entryCount = view.getUint32(8, true);
  const blockCount = view.getUint32(12, true);
  const dataLen = view.getUint32(16, true);
  const wide = version >= VERSION_V4;
  const bloomHashCount = wide ? view.getUint32(20, true) : view.getUint16(20, true);
  const bloomByteLen = wide ? view.getUint32(24, true) : view.getUint16(22, true);
  const bloomStart = wide ? 28 : 24;
  const bloomBits = buf.slice(bloomStart, bloomStart + bloomByteLen);
  const dataStart = bloomStart + bloomByteLen;
  const indexStart = dataStart + dataLen;
  if (indexStart > crcOff) throw new CorruptDatabaseError("sst v2 data OOB");
  return {
    view,
    crcOff,
    entryCount,
    blockCount,
    dataLen,
    bloom: { bits: bloomBits, hashCount: bloomHashCount },
    dataStart,
    indexStart,
    indexEnd: crcOff,
    codec: "raw",
  };
}

/** v5 to v7 share a footer. v6 adds the codec after the index length. */
function parseFooterLayout(buf: Uint8Array, version: number): BlockLayout {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const fields = version >= VERSION_V6 ? 8 : 7;
  const footer = buf.byteLength - (fields + 3) * 4;
  const field = (i: number) => view.getUint32(footer + 4 * i, true);
  const [entryCount, blockCount, bloomOffset, bloomLen, bloomHashCount, indexOffset, indexLen] =
    [0, 1, 2, 3, 4, 5, 6].map(field) as [number, number, number, number, number, number, number];
  if (indexOffset !== bloomOffset + bloomLen || indexOffset + indexLen !== footer) {
    throw new CorruptDatabaseError("sst footer sections OOB");
  }
  const codec = fields === 8 ? CODECS[field(7)] : "raw";
  if (!codec) throw new CorruptDatabaseError(`unsupported sst codec ${field(7)}`);
  return {
    view,
    crcOff: footer + 4 * fields,
    entryCount,
    blockCount,
    dataLen: bloomOffset,
    bloom: { bits: buf.slice(bloomOffset, indexOffset), hashCount: bloomHashCount },
    dataStart: 0,
    indexStart: indexOffset,
    indexEnd: footer,
    codec,
  };
}

function readBlockIndex(
  buf: Uint8Array,
  view: DataView,
  indexStart: number,
  indexEnd: number,
  blockCount: number,
): BlockIndexEntry[] {
  const index: BlockIndexEntry[] = [];
  let o = indexStart;
  for (let i = 0; i < blockCount; i++) {
    const firstLen = view.getUint32(o, true);
    o += 4;
    const firstKey = buf.slice(o, o + firstLen);
    o += firstLen;
    const lastLen = view.getUint32(o, true);
    o += 4;
    const lastKey = buf.slice(o, o + lastLen);
    o += lastLen;
    const offset = view.getUint32(o, true);
    o += 4;
    const length = view.getUint32(o, true);
    o += 4;
    index.push({ firstKey, lastKey, offset, length });
  }
  if (o !== indexEnd) throw new CorruptDatabaseError("sst v2 index trailing");
  return index;
}

/** One block's unpacked bytes: a u32 record count at `start`, then records up to `end`. */
type BlockBytes = { buf: Uint8Array; view: DataView; start: number; end: number };

function blockBytes(
  buf: Uint8Array,
  view: DataView,
  dataStart: number,
  ix: BlockIndexEntry,
  codec: SstCodec,
): BlockBytes {
  const start = dataStart + ix.offset;
  const end = start + ix.length;
  if (end > buf.byteLength || ix.length < 4) throw new CorruptDatabaseError("sst block OOB");
  if (codec === "raw") return { buf, view, start, end };
  const block = lz4Decompress(buf.subarray(start + 4, end), view.getUint32(start, true));
  if (block.byteLength < 4) throw new CorruptDatabaseError("sst block too short");
  return { buf: block, view: new DataView(block.buffer), start: 0, end: block.byteLength };
}

/** `buf[at, at + len)` compared with `key` from `from` on, like `compareBytes`. */
function compareAt(buf: Uint8Array, at: number, len: number, key: Uint8Array, from: number): number {
  const keyLen = key.byteLength - from;
  const n = Math.min(len, keyLen);
  for (let i = 0; i < n; i++) {
    const d = buf[at + i]! - key[from + i]!;
    if (d !== 0) return d;
  }
  return len - keyLen;
}

/**
 * The record for `key` in one block, or undefined. Checks the block prefix
 * once, then compares suffixes in place and copies out only the match.
 * A v7 block binary-searches its sampled records first, then walks at
 * most `OFFSET_STRIDE` records from the last sampled one not past `key`.
 */
function findInBlock(b: BlockBytes, key: Uint8Array, fmt: RecordFormat): SstEntry | undefined {
  const w = RecordWalker.ofBlock(b, fmt);
  const p = w.prefixLen;
  if (key.byteLength < p) return undefined;
  for (let i = 0; i < p; i++) if (w.buf[w.prefixAt + i] !== key[i]) return undefined;
  let walk = w.count;
  if (fmt.prefixed && w.count > OFFSET_STRIDE) {
    const first = w.o;
    const at = (j: number) => {
      const o = b.start + b.view.getUint16(w.end + 2 * (j - 1), true);
      if (o <= first || o >= w.end) throw new CorruptDatabaseError("sst offset OOB");
      return o;
    };
    let lo = 0;
    let hi = (w.count - 1) / OFFSET_STRIDE | 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      w.o = at(mid);
      w.next();
      const c = compareAt(w.buf, w.keyAt, w.keyLen, key, p);
      if (c === 0) return w.entry();
      if (c < 0) lo = mid;
      else hi = mid - 1;
    }
    w.o = lo === 0 ? first : at(lo);
    walk = Math.min(OFFSET_STRIDE, w.count - lo * OFFSET_STRIDE);
  }
  for (let i = 0; i < walk; i++) {
    w.next();
    const c = compareAt(w.buf, w.keyAt, w.keyLen, key, p);
    if (c > 0) return undefined;
    if (c === 0) return w.entry();
  }
  return undefined;
}

export function decodeSst(buf: Uint8Array): SstEntry[] {
  if (buf.byteLength < 16) {
    throw new CorruptDatabaseError("sst too short");
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const version = sstVersion(buf, view);
  const crcOff = buf.byteLength - 4;

  if (version === VERSION_V1) {
    if (crc32(buf.subarray(0, crcOff)) !== view.getUint32(crcOff, true)) {
      throw new CorruptDatabaseError("sst crc mismatch");
    }
    return decodeSstV1(buf, view, crcOff);
  }

  if (!isBlockVersion(version)) {
    throw new CorruptDatabaseError(`unsupported sst version ${version}`);
  }

  const meta = parseBlockLayout(buf, version);
  if (crc32(buf.subarray(0, meta.crcOff)) !== meta.view.getUint32(meta.crcOff, true)) {
    throw new CorruptDatabaseError("sst crc mismatch");
  }
  const index = readBlockIndex(
    buf,
    meta.view,
    meta.indexStart,
    meta.indexEnd,
    meta.blockCount,
  );
  const out: SstEntry[] = [];
  for (const ix of index) {
    out.push(
      ...RecordWalker.ofBlock(blockBytes(buf, meta.view, meta.dataStart, ix, meta.codec), recordFormat(version)).entries(),
    );
  }
  if (out.length !== meta.entryCount) {
    throw new CorruptDatabaseError("sst v2 entry count mismatch");
  }
  return out;
}

/**
 * Lazy SST reader: Bloom + block index, decode one block per miss. It skips
 * the footer CRC, which costs a pass over the whole file on the tab's main
 * thread at every new generation. Compaction decodes each run in full, and
 * that decode checks the CRC.
 */
export class SstReader {
  private readonly buf: Uint8Array;
  private readonly view: DataView;
  private readonly version: number;
  private readonly fmt: RecordFormat;
  private readonly v1Entries: SstEntry[] | undefined;
  private readonly bloom: BloomFilter | undefined;
  private readonly dataStart: number = 0;
  private readonly index: BlockIndexEntry[] = [];
  private readonly entryCount: number = 0;
  private readonly codec: SstCodec = "raw";

  constructor(buf: Uint8Array) {
    if (buf.byteLength < 16) throw new CorruptDatabaseError("sst too short");
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.version = sstVersion(buf, this.view);
    this.fmt = recordFormat(this.version);
    if (this.version === VERSION_V1) {
      this.v1Entries = decodeSst(buf);
      return;
    }
    if (!isBlockVersion(this.version)) {
      throw new CorruptDatabaseError(`unsupported sst version ${this.version}`);
    }
    const meta = parseBlockLayout(buf, this.version);
    this.bloom = meta.bloom;
    this.dataStart = meta.dataStart;
    this.entryCount = meta.entryCount;
    this.codec = meta.codec;
    this.index = readBlockIndex(
      buf,
      meta.view,
      meta.indexStart,
      meta.indexEnd,
      meta.blockCount,
    );
  }

  /** The smallest and largest key, or undefined for an empty run. */
  get range(): { smallest: Uint8Array; largest: Uint8Array } | undefined {
    if (this.version === VERSION_V1) {
      const entries = this.v1Entries!;
      if (entries.length === 0) return undefined;
      return { smallest: entries[0]!.key, largest: entries[entries.length - 1]!.key };
    }
    const first = this.index[0];
    const last = this.index[this.index.length - 1];
    if (!first || !last || this.entryCount === 0) return undefined;
    return { smallest: first.firstKey, largest: last.lastKey };
  }

  mightContain(key: Uint8Array): boolean {
    if (this.version === VERSION_V1) return true;
    const first = this.index[0];
    const last = this.index[this.index.length - 1];
    if (first && compareBytes(key, first.firstKey) < 0) return false;
    if (last && compareBytes(key, last.lastKey) > 0) return false;
    return bloomMightContain(this.bloom!, key);
  }

  /** Point lookup that reads one block in place. The block is not retained. */
  get(key: Uint8Array): SstEntry | undefined {
    if (this.version === VERSION_V1) {
      return sstGet(this.v1Entries!, key);
    }
    if (!this.mightContain(key)) return undefined;
    const bi = this.findBlock(key);
    if (bi < 0) return undefined;
    return findInBlock(this.blockBytes(bi), key, this.fmt);
  }

  /**
   * Block-index seek. Decodes the current block into cursor-local state.
   * Advances to the next block when the current one is exhausted.
   */
  cursor(bounds?: ScanBounds): LayerCursor {
    if (this.version === VERSION_V1) {
      return entryCursor(this.v1Entries ?? [], bounds);
    }
    return this.v2Cursor(bounds);
  }

  private findBlock(key: Uint8Array): number {
    let lo = 0;
    let hi = this.index.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const ix = this.index[mid]!;
      if (compareBytes(key, ix.firstKey) < 0) {
        hi = mid - 1;
        continue;
      }
      if (compareBytes(key, ix.lastKey) > 0) {
        lo = mid + 1;
        continue;
      }
      return mid;
    }
    return -1;
  }

  private blockBytes(i: number): BlockBytes {
    return blockBytes(this.buf, this.view, this.dataStart, this.index[i]!, this.codec);
  }

  private loadBlock(i: number): SstEntry[] {
    return RecordWalker.ofBlock(this.blockBytes(i), this.fmt).entries();
  }

  private v2Cursor(bounds?: ScanBounds): LayerCursor {
    const index = this.index;
    let bi = seekBlock(index, bounds?.start);
    let slots: SstEntry[] = [];
    let i = 0;
    const load = () => {
      if (bi >= index.length) {
        slots = [];
        i = 0;
        return;
      }
      const block = index[bi]!;
      if (
        bounds?.endExclusive &&
        compareBytes(block.firstKey, bounds.endExclusive) >= 0
      ) {
        bi = index.length;
        slots = [];
        i = 0;
        return;
      }
      slots = this.loadBlock(bi);
      i = bounds?.start ? lowerBoundKeys(slots, bounds.start) : 0;
    };
    load();
    return {
      peek() {
        while (true) {
          if (i < slots.length) {
            const e = slots[i]!;
            if (
              bounds?.endExclusive &&
              compareBytes(e.key, bounds.endExclusive) >= 0
            ) {
              return undefined;
            }
            return e.kind === "put"
              ? { key: e.key, kind: "put" as const, value: e.value }
              : { key: e.key, kind: "del" as const };
          }
          bi += 1;
          load();
          if (bi >= index.length && i >= slots.length) return undefined;
        }
      },
      next() {
        i += 1;
      },
    };
  }
}

function seekBlock(
  index: readonly BlockIndexEntry[],
  start: Uint8Array | undefined,
): number {
  if (start === undefined) return 0;
  let lo = 0;
  let hi = index.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compareBytes(index[mid]!.lastKey, start) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Point lookup in a decoded (sorted) SST. */
export function sstGet(
  entries: readonly SstEntry[],
  key: Uint8Array,
): SstEntry | undefined {
  let lo = 0;
  let hi = entries.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const e = entries[mid]!;
    const c = compareBytes(e.key, key);
    if (c === 0) return e;
    if (c < 0) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}

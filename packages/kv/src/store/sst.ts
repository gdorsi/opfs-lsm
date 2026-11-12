import { compareBytes } from "../bytes.js";
import { CorruptDatabaseError } from "../errors.js";
import type { LayerEntry } from "./cursor.js";
import { bloomAdd, createBloom, type BloomFilter } from "./bloom.js";
import { crc32 } from "./crc32.js";
import { lz4Decompress } from "./lz4.js";

/** Magic ASCII "OLST" (opfs-lsm SST). Version and magic sit in the last 8 bytes. */
const SST_MAGIC = 0x4f4c5354;
const VERSION = 2;
export const SST_FOOTER_BYTES = 44;
/**
 * The most Bloom hashes a footer may name. The encoder writes 7; a get
 * loops once per hash, so a corrupt count must not set its cost.
 */
const MAX_BLOOM_HASHES = 32;
/** The smallest index entry: two u32 key lengths, offset and length. */
const MIN_INDEX_ENTRY_BYTES = 16;

/**
 * How a run stores its data blocks. An LZ4 block is a u32 uncompressed
 * length followed by LZ4 block-format bytes.
 */
export type SstCodec = "raw" | "lz4";
const CODECS: readonly SstCodec[] = ["raw", "lz4"];

const TAG_PUT = 1;
const TAG_DEL = 2;
/** A put with an expiry: a u64 epoch-ms `expiresAt` follows the seq. */
const TAG_PUT_EXPIRING = 3;

/** Target encoded size of one data block. */
export const SST_BLOCK_TARGET = 4 * 1024;

/**
 * A block stores the offset of every `OFFSET_STRIDE`th record after
 * the first, so a get binary-searches them and walks at most
 * `OFFSET_STRIDE - 1` records. `crates/engine-core/src/sst.rs` uses the
 * same stride.
 */
const OFFSET_STRIDE = 4;

/**
 * Bytes of a block's offset table: a u16 per sampled record. Only a
 * block of one record can pass the u16 range, and it has no table.
 */
function offsetTableBytes(count: number): number {
  return count > 1 ? 2 * Math.floor((count - 1) / OFFSET_STRIDE) : 0;
}

/** `seq` is the WAL seq that wrote the entry. Seqs start at 1. */
export type SstEntry =
  | {
      readonly kind: "put";
      readonly key: Uint8Array;
      readonly value: Uint8Array;
      readonly seq: number;
      /** Epoch ms from which the put reads as absent. Absent: never. */
      readonly expiresAt?: number;
    }
  | { readonly kind: "del"; readonly key: Uint8Array; readonly seq: number };

/** The smallest and largest key of a run. */
export type KeyRange = {
  readonly smallest: Uint8Array;
  readonly largest: Uint8Array;
};

/**
 * What an encoder reports when a run ends, and what the manifest records, so
 * nobody reads a run back for its size or its keys.
 */
export type RunEnd = {
  /** Bytes of the whole run file. */
  readonly bytes: number;
  /** Undefined for an empty run, which has no keys. */
  readonly range?: KeyRange;
};

/** A run's bytes and its `RunEnd`. */
export type EncodedRun = {
  readonly body: Uint8Array;
  readonly end: RunEnd;
};

type BlockIndexEntry = {
  firstKey: Uint8Array;
  lastKey: Uint8Array;
  offset: number;
  length: number;
};

/**
 * Upper bound on an encoded record: tag, seq, expiry, and u32 lengths.
 * On-disk records use varints and a shared prefix, so they are never
 * larger. Compaction cuts runs by this without encoding them.
 */
export function entryRecordSize(e: SstEntry): number {
  let n = 1 + 8 + 4 + e.key.byteLength;
  if (e.kind === "put") n += 4 + e.value.byteLength + expiryBytes(e);
  return n;
}

function expiryBytes(e: SstEntry): number {
  return e.kind === "put" && e.expiresAt !== undefined ? 8 : 0;
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
 * A record's bytes besides its key suffix. The suffix length varint is
 * sized from the whole key, an upper bound that stays fixed as the
 * block prefix shrinks, so a block is sized from running sums.
 * `crates/engine-core/src/sst.rs` sizes blocks the same way.
 */
function recordOverhead(e: SstEntry): number {
  const n = 1 + 8 + varintLen(e.key.byteLength);
  return e.kind === "put" ? n + expiryBytes(e) + varintLen(e.value.byteLength) + e.value.byteLength : n;
}

/**
 * Cut sorted entries into blocks of at most `target` encoded bytes, or one
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
 * One data block before compression:
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
    if (e.kind === "put") size += expiryBytes(e) + varintLen(e.value.byteLength) + e.value.byteLength;
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

/** u8 tag | u64 seq | (tag 3) u64 expiresAt | varint suffixLen | suffix | (put) varint valLen | value */
function writeRecord(out: Uint8Array, view: DataView, o: number, e: SstEntry, prefixLen: number): number {
  const expiresAt = e.kind === "put" ? e.expiresAt : undefined;
  out[o++] = e.kind === "del" ? TAG_DEL : expiresAt === undefined ? TAG_PUT : TAG_PUT_EXPIRING;
  view.setBigUint64(o, BigInt(e.seq), true);
  o += 8;
  if (expiresAt !== undefined) {
    view.setBigUint64(o, BigInt(expiresAt), true);
    o += 8;
  }
  o = writeVarint(out, o, e.key.byteLength - prefixLen);
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
 * Walks the records of one block in place. `next` reads the record at `o`
 * into the fields, so a reader copies out only what it keeps. Keys are the
 * block's `prefixLen` bytes at `prefixAt`, then the record's suffix.
 */
class RecordWalker {
  tag = 0;
  seqAt = 0;
  /** Where the record's expiry is, 0 for a record with none. */
  expiresAt = 0;
  keyAt = 0;
  keyLen = 0;
  valAt = 0;
  valLen = 0;
  private prefix: Uint8Array | undefined;

  constructor(
    readonly buf: Uint8Array,
    readonly view: DataView,
    public o: number,
    readonly end: number,
    readonly count: number,
    readonly prefixAt: number,
    readonly prefixLen: number,
    readonly start: number,
  ) {}

  /**
   * One unpacked block: u32 count, varint prefix length, prefix, then
   * records. `end` is where the offset table starts.
   */
  static ofBlock(b: BlockBytes): RecordWalker {
    const count = b.view.getUint32(b.start, true);
    const w = new RecordWalker(b.buf, b.view, b.start + 4, b.end, count, 0, 0, b.start);
    const p = w.len();
    const end = b.end - offsetTableBytes(count);
    if (w.o + p > end) throw new CorruptDatabaseError("sst prefix OOB");
    return new RecordWalker(b.buf, b.view, w.o + p, end, count, w.o, p, b.start);
  }

  /** Where record `j * OFFSET_STRIDE` starts, for `j >= 1`, from the block's offset table. */
  sampleAt(j: number): number {
    const o = this.start + this.view.getUint16(this.end + 2 * (j - 1), true);
    if (o <= this.prefixAt + this.prefixLen || o >= this.end) throw new CorruptDatabaseError("sst offset OOB");
    return o;
  }

  /** Reads the record at `o`. Gets walk a block with this, so lengths under 128 skip `len`. */
  next(): void {
    const buf = this.buf;
    let o = this.o;
    if (o >= this.end) throw new CorruptDatabaseError("sst truncated");
    const tag = buf[o]!;
    this.seqAt = o + 1;
    o += 9;
    if (tag === TAG_PUT_EXPIRING) {
      this.expiresAt = o;
      o += 8;
    } else {
      this.expiresAt = 0;
    }
    let n = buf[o]!;
    if (n < 0x80) o++;
    else {
      this.o = o;
      n = this.len();
      o = this.o;
    }
    this.keyAt = o;
    this.keyLen = n;
    o += n;
    if (tag === TAG_PUT || tag === TAG_PUT_EXPIRING) {
      n = buf[o]!;
      if (n < 0x80) o++;
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
    return Number(this.view.getBigUint64(this.seqAt, true));
  }

  key(): Uint8Array {
    const { buf, prefixLen, keyAt, keyLen } = this;
    if (prefixLen === 0) return buf.slice(keyAt, keyAt + keyLen);
    // The record's own bytes always sit before its suffix, so one slice
    // copies the suffix at the right place, then the prefix overwrites the
    // head. Two block copies beat a byte loop and a fresh subarray per key.
    const k = buf.slice(keyAt - prefixLen, keyAt + keyLen);
    k.set((this.prefix ??= buf.subarray(this.prefixAt, this.prefixAt + prefixLen)));
    return k;
  }

  value(): Uint8Array {
    return this.buf.slice(this.valAt, this.valAt + this.valLen);
  }

  entry(): SstEntry {
    const key = this.key();
    const seq = this.seq();
    if (this.tag === TAG_DEL) return { kind: "del", key, seq };
    const value = this.value();
    if (this.expiresAt === 0) return { kind: "put", key, value, seq };
    return { kind: "put", key, value, seq, expiresAt: Number(this.view.getBigUint64(this.expiresAt, true)) };
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
 * Encode SST version 2 with raw blocks. LZ4 blocks come only from the wasm encoder.
 *   data blocks (see `encodeBlock`)
 *   bloom bits
 *   index (each: u32 firstLen|key | u32 lastLen|key | u32 offset | u32 length)
 *   footer, 44 bytes:
 *     u32 entryCount | u32 blockCount | u32 bloomOffset | u32 bloomLen
 *     u32 bloomHashCount | u32 indexOffset | u32 indexLen | u32 codec
 *     u32 crc32 of every byte before it | u32 version=2 | u32 magic
 */
export function encodeRun(
  entries: readonly SstEntry[],
  blockTarget = SST_BLOCK_TARGET,
): EncodedRun {
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

  const out = new Uint8Array(dataLen + bloom.bits.byteLength + indexSize + SST_FOOTER_BYTES);
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
  view.setUint32(o + 4, VERSION, true);
  view.setUint32(o + 8, SST_MAGIC, true);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  return {
    body: out,
    end: {
      bytes: out.byteLength,
      ...(first && last && { range: { smallest: first.key.slice(), largest: last.key.slice() } }),
    },
  };
}

/** `encodeRun`'s bytes. */
export function encodeSst(entries: readonly SstEntry[], blockTarget = SST_BLOCK_TARGET): Uint8Array {
  return encodeRun(entries, blockTarget).body;
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

/** The footer's fields. Offsets are from the start of the file. */
export type SstFooter = {
  entryCount: number;
  blockCount: number;
  /** Data blocks are `[0, dataLen)`; the Bloom bits start here. */
  dataLen: number;
  bloomHashCount: number;
  indexStart: number;
  /** Where the footer starts, which is also where the index ends. */
  indexEnd: number;
  codec: SstCodec;
};

/**
 * Footer is 8 u32 fields, then CRC, version, and magic. Rejects any other
 * version. `tail` is the last `tail.byteLength` bytes of a `fileSize`-byte run.
 */
export function readFooter(tail: Uint8Array, fileSize: number): SstFooter {
  if (tail.byteLength < SST_FOOTER_BYTES || fileSize < tail.byteLength) throw new CorruptDatabaseError("sst too short");
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  const magic = view.getUint32(tail.byteLength - 4, true);
  if (magic !== SST_MAGIC) throw new CorruptDatabaseError(`bad sst magic ${magic.toString(16)}`);
  const version = view.getUint32(tail.byteLength - 8, true);
  if (version !== VERSION) throw new CorruptDatabaseError(`unsupported sst version ${version}`);
  const at = tail.byteLength - SST_FOOTER_BYTES;
  const field = (i: number) => view.getUint32(at + 4 * i, true);
  const [entryCount, blockCount, bloomOffset, bloomLen, bloomHashCount, indexOffset, indexLen, codecId] =
    [0, 1, 2, 3, 4, 5, 6, 7].map(field) as [number, number, number, number, number, number, number, number];
  const footer = fileSize - SST_FOOTER_BYTES;
  if (indexOffset !== bloomOffset + bloomLen || indexOffset + indexLen !== footer) {
    throw new CorruptDatabaseError("sst footer sections OOB");
  }
  const codec = CODECS[codecId];
  if (!codec) throw new CorruptDatabaseError(`unsupported sst codec ${codecId}`);
  if (bloomHashCount > MAX_BLOOM_HASHES) throw new CorruptDatabaseError(`sst bloom hash count ${bloomHashCount}`);
  if (blockCount * MIN_INDEX_ENTRY_BYTES > indexLen) throw new CorruptDatabaseError("sst block count past the index");
  return { entryCount, blockCount, dataLen: bloomOffset, bloomHashCount, indexStart: indexOffset, indexEnd: footer, codec };
}

function parseFooter(buf: Uint8Array): BlockLayout {
  const f = readFooter(buf, buf.byteLength);
  return {
    view: new DataView(buf.buffer, buf.byteOffset, buf.byteLength),
    crcOff: f.indexEnd + 32,
    entryCount: f.entryCount,
    blockCount: f.blockCount,
    dataLen: f.dataLen,
    bloom: { bits: buf.slice(f.dataLen, f.indexStart), hashCount: f.bloomHashCount },
    dataStart: 0,
    indexStart: f.indexStart,
    indexEnd: f.indexEnd,
    codec: f.codec,
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
  const u32 = () => {
    if (o + 4 > indexEnd) throw new CorruptDatabaseError("sst index OOB");
    o += 4;
    return view.getUint32(o - 4, true);
  };
  const key = () => {
    const len = u32();
    if (o + len > indexEnd) throw new CorruptDatabaseError("sst index OOB");
    o += len;
    return buf.slice(o - len, o);
  };
  for (let i = 0; i < blockCount; i++) {
    const firstKey = key();
    const lastKey = key();
    const offset = u32();
    const length = u32();
    index.push({ firstKey, lastKey, offset, length });
  }
  if (o !== indexEnd) throw new CorruptDatabaseError("sst index trailing");
  return index;
}

/**
 * The framed length of each data block, in file order, from `meta`: a run's
 * bytes from `footer.dataLen` to its end. Encoders write blocks back to back
 * from offset 0 and a merge reads them that way, so the index must agree.
 */
export function blockLengths(meta: Uint8Array, footer: SstFooter): number[] {
  const view = new DataView(meta.buffer, meta.byteOffset, meta.byteLength);
  const index = readBlockIndex(meta, view, footer.indexStart - footer.dataLen, footer.indexEnd - footer.dataLen, footer.blockCount);
  let next = 0;
  const lengths = index.map(({ offset, length }) => {
    if (offset !== next || length > footer.dataLen - offset) throw new CorruptDatabaseError("sst blocks do not tile the data");
    next += length;
    return length;
  });
  if (next !== footer.dataLen) throw new CorruptDatabaseError("sst blocks do not tile the data");
  return lengths;
}

/** One data block, framed as the block index frames it, decoded as `decodeSst` decodes it. */
export function decodeBlock(framed: Uint8Array, codec: SstCodec): SstEntry[] {
  const view = new DataView(framed.buffer, framed.byteOffset, framed.byteLength);
  return RecordWalker.ofBlock(blockBytes(framed, view, 0, { offset: 0, length: framed.byteLength }, codec)).entries();
}

/** One block's unpacked bytes: a u32 record count at `start`, then records up to `end`. */
export type BlockBytes = { buf: Uint8Array; view: DataView; start: number; end: number };

export function blockBytes(
  buf: Uint8Array,
  view: DataView,
  dataStart: number,
  ix: { readonly offset: number; readonly length: number },
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
 * Moves `w` to the first record whose suffix is not below `key` from
 * `w.prefixLen` on, and returns how many records are left from there.
 * A block binary-searches its sampled records, then walks at most
 * `OFFSET_STRIDE` records.
 */
function seekSuffix(w: RecordWalker, key: Uint8Array): number {
  const p = w.prefixLen;
  let i = 0;
  if (w.count > OFFSET_STRIDE) {
    const first = w.o;
    let lo = 0;
    let hi = ((w.count - 1) / OFFSET_STRIDE) | 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      w.o = w.sampleAt(mid);
      w.next();
      if (compareAt(w.buf, w.keyAt, w.keyLen, key, p) < 0) lo = mid;
      else hi = mid - 1;
    }
    w.o = lo === 0 ? first : w.sampleAt(lo);
    i = lo * OFFSET_STRIDE;
  }
  for (; i < w.count; i++) {
    const at = w.o;
    w.next();
    if (compareAt(w.buf, w.keyAt, w.keyLen, key, p) >= 0) {
      w.o = at;
      return w.count - i;
    }
  }
  return 0;
}

/** Like `seekSuffix`, for a `key` that may not share the block's prefix. */
function seekInBlock(w: RecordWalker, key: Uint8Array): number {
  const p = w.prefixLen;
  const n = Math.min(p, key.byteLength);
  for (let i = 0; i < n; i++) {
    const d = w.buf[w.prefixAt + i]! - key[i]!;
    if (d !== 0) return d > 0 ? w.count : 0;
  }
  return key.byteLength < p ? w.count : seekSuffix(w, key);
}

/**
 * The record for `key` in one block, or undefined. Checks the block prefix
 * once, then compares suffixes in place and copies out only the match.
 */
export function findInBlock(b: BlockBytes, key: Uint8Array): SstEntry | undefined {
  const w = RecordWalker.ofBlock(b);
  const p = w.prefixLen;
  if (key.byteLength < p) return undefined;
  for (let i = 0; i < p; i++) if (w.buf[w.prefixAt + i] !== key[i]) return undefined;
  if (seekSuffix(w, key) === 0) return undefined;
  w.next();
  return compareAt(w.buf, w.keyAt, w.keyLen, key, p) === 0 ? w.entry() : undefined;
}

export function decodeSst(buf: Uint8Array): SstEntry[] {
  const meta = parseFooter(buf);
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
    out.push(...RecordWalker.ofBlock(blockBytes(buf, meta.view, meta.dataStart, ix, meta.codec)).entries());
  }
  if (out.length !== meta.entryCount) {
    throw new CorruptDatabaseError("sst entry count mismatch");
  }
  return out;
}

/**
 * The smallest and largest key of a whole run file, read from its index, or
 * undefined for an empty run. Encoders report the same range in `RunEnd`.
 */
export function sstKeyRange(buf: Uint8Array): KeyRange | undefined {
  const meta = parseFooter(buf);
  if (meta.entryCount === 0) return undefined;
  const index = readBlockIndex(buf, meta.view, meta.indexStart, meta.indexEnd, meta.blockCount);
  const first = index[0];
  const last = index[index.length - 1];
  return first && last ? { smallest: first.firstKey, largest: last.lastKey } : undefined;
}

/**
 * The records of one block in key order, from the first key at or after
 * `seek`. Each entry's key and value are copied out once, when reached.
 */
export class BlockEntries {
  private readonly w: RecordWalker;
  private left: number;

  constructor(b: BlockBytes, seek?: Uint8Array) {
    this.w = RecordWalker.ofBlock(b);
    this.left = seek ? seekInBlock(this.w, seek) : this.w.count;
  }

  next(): LayerEntry | undefined {
    if (this.left === 0) return undefined;
    this.left--;
    this.w.next();
    return this.w.entry();
  }
}

export class ReverseBlockEntries {
  private readonly w: RecordWalker;
  private readonly starts: number[] = [];

  constructor(b: BlockBytes, seek?: Uint8Array) {
    const w = (this.w = RecordWalker.ofBlock(b));
    const first = w.o;
    const below = seek ? w.count - seekInBlock(w, seek) : w.count;
    w.o = first;
    for (let i = 0; i < below; i++) {
      const at = w.o;
      w.next();
      this.starts.push(at);
    }
  }

  next(): LayerEntry | undefined {
    const at = this.starts.pop();
    if (at === undefined) return undefined;
    const w = this.w;
    w.o = at;
    w.next();
    return w.entry();
  }
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

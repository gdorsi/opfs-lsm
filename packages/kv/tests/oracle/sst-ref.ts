import { compareBytes } from "../../src/bytes.js";
import { CorruptDatabaseError } from "../../src/errors.js";
import type { BloomFilter } from "../../src/store/bloom.js";
import { crc32 } from "../../src/store/crc32.js";
import {
  blockBytes,
  readFooter,
  RecordWalker,
  SST_FOOTER_BYTES,
  type BlockBytes,
  type BlockIndex,
  type EncodedRun,
  type KeyRange,
  type SstEntry,
  type SstFooter,
} from "../../src/store/sst.js";

/**
 * A second, independent TypeScript implementation of the run format: the
 * writer and the whole-file decoders the tests check the wasm encoder, the
 * merge and the readers against. The engine writes runs with the wasm
 * module only, so nothing in `src` may import this.
 */

const SST_MAGIC = 0x4f4c5354;
const VERSION = 2;
const TAG_PUT = 1;
const TAG_DEL = 2;
const OFFSET_STRIDE = 4;

/** Target encoded size of one data block. */
export const SST_BLOCK_TARGET = 32 * 1024;

function offsetTableBytes(count: number): number {
  return count > 1 ? 2 * Math.floor((count - 1) / OFFSET_STRIDE) : 0;
}

type BlockIndexEntry = {
  firstKey: Uint8Array;
  lastKey: Uint8Array;
  offset: number;
  length: number;
};

/** What a reader keeps of the index: each block's start, and the shortest prefix of its first key above the last key before it. */
function blockIndexOf(index: readonly BlockIndexEntry[]): BlockIndex {
  const seps = index.map((ix, i) => (i === 0 ? ix.firstKey : ix.firstKey.subarray(0, commonPrefix(index[i - 1]!.lastKey, ix.firstKey) + 1)));
  const sepEnd = new Uint32Array(index.length);
  let total = 0;
  seps.forEach((sep, i) => (sepEnd[i] = total += sep.byteLength));
  const sepBytes = new Uint8Array(total);
  seps.forEach((sep, i) => sepBytes.set(sep, sepEnd[i]! - sep.byteLength));
  const last = index[index.length - 1];
  return { sepBytes, sepEnd, blockStart: Uint32Array.from([...index.map((ix) => ix.offset), last ? last.offset + last.length : 0]) };
}

/**
 * Upper bound on an encoded record: tag, seq, and u32 lengths. On-disk
 * records use varints and a shared prefix, so they are never larger.
 * Compaction cuts runs by this without encoding them.
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
 * A record's bytes besides its key suffix. The suffix length varint is
 * sized from the whole key, an upper bound that stays fixed as the
 * block prefix shrinks, so a block is sized from running sums.
 * `packages/kv/engine/sst.ts` sizes blocks the same way.
 */
function recordOverhead(e: SstEntry): number {
  const n = 1 + 8 + varintLen(e.key.byteLength);
  return e.kind === "put" ? n + varintLen(e.value.byteLength) + e.value.byteLength : n;
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
 * One data block:
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
  view.setBigUint64(o, BigInt(e.seq), true);
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
 * Encode SST version 2.
 *   data blocks (see `encodeBlock`)
 *   bloom bits
 *   index (each: u32 firstLen|key | u32 lastLen|key | u32 offset | u32 length)
 *   footer, 40 bytes:
 *     u32 entryCount | u32 blockCount | u32 bloomOffset | u32 bloomLen
 *     u32 bloomHashCount | u32 indexOffset | u32 indexLen
 *     u32 crc32 of every byte before it | u32 version=2 | u32 magic
 */
export function encodeRunRef(
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
      index: blockIndexOf(index),
    },
  };
}

/** `encodeRunRef`'s bytes. */
export function encodeSstRef(entries: readonly SstEntry[], blockTarget = SST_BLOCK_TARGET): Uint8Array {
  return encodeRunRef(entries, blockTarget).body;
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
};

function parseFooter(buf: Uint8Array): BlockLayout {
  const f = readFooter(buf, buf.byteLength);
  return {
    view: new DataView(buf.buffer, buf.byteOffset, buf.byteLength),
    crcOff: f.indexEnd + 28,
    entryCount: f.entryCount,
    blockCount: f.blockCount,
    dataLen: f.dataLen,
    bloom: { bits: buf.slice(f.dataLen, f.indexStart), hashCount: f.bloomHashCount },
    dataStart: 0,
    indexStart: f.indexStart,
    indexEnd: f.indexEnd,
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
 * The length of each data block, in file order, from `meta`: a run's
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

/** Every record of one block, checking the block holds nothing after them. */
function walkBlock(b: BlockBytes): SstEntry[] {
  const w = new RecordWalker(b);
  const out: SstEntry[] = new Array(w.count);
  for (let i = 0; i < w.count; i++) {
    w.next();
    const key = w.inPlace().key;
    const seq = w.seq();
    out[i] = w.tag === TAG_PUT ? { kind: "put", key, value: w.valueInPlace().slice(), seq } : { kind: "del", key, seq };
  }
  if (w.o !== w.end) throw new CorruptDatabaseError("sst block trailing");
  return out;
}

/** One data block, decoded as `decodeSst` decodes it. */
export function decodeBlock(block: Uint8Array): SstEntry[] {
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  return walkBlock(blockBytes(block, view, 0, block.byteLength));
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
    out.push(...walkBlock(blockBytes(buf, meta.view, meta.dataStart + ix.offset, ix.length)));
  }
  if (out.length !== meta.entryCount) {
    throw new CorruptDatabaseError("sst entry count mismatch");
  }
  return out;
}

/** The block index of a whole run file, read from its tail. Encoders report the same index in `RunEnd`. */
export function sstBlockIndex(buf: Uint8Array): BlockIndex {
  const meta = parseFooter(buf);
  return blockIndexOf(readBlockIndex(buf, meta.view, meta.indexStart, meta.indexEnd, meta.blockCount));
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

const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

function fnv1a(data: Uint8Array): number {
  let h = FNV_OFFSET;
  for (let i = 0; i < data.byteLength; i++) {
    h ^= data[i] ?? 0;
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}

function mix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/** ~1% false-positive with 10 bits/key, so k is about 7. */
export function createBloom(keyCount: number, bitsPerKey = 10): BloomFilter {
  const bitCount = Math.max(64, Math.max(1, keyCount) * bitsPerKey);
  return {
    bits: new Uint8Array(Math.ceil(bitCount / 8)),
    hashCount: Math.max(1, Math.round(bitsPerKey * Math.LN2)),
  };
}

export function bloomAdd(filter: BloomFilter, key: Uint8Array): void {
  const m = filter.bits.byteLength * 8;
  const h1 = fnv1a(key);
  const h2 = mix(h1) | 1;
  for (let i = 0; i < filter.hashCount; i++) {
    const bit = ((h1 + Math.imul(i, h2)) >>> 0) % m;
    filter.bits[bit >>> 3] = (filter.bits[bit >>> 3] ?? 0) | (1 << (bit & 7));
  }
}

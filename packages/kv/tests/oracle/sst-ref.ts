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
  type RunEnd,
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
const VERSION = 3;
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
 * `index` as a manifest records it: u32 blocks, each block's separator length
 * and byte length as varints, the separators, then a CRC-32. Written from the decoded
 * index, so a test checks the engine's encoder and `decodeIndex` against it.
 */
export function indexBlob(index: BlockIndex): Uint8Array {
  const { sepBytes, sepEnd, blockStart } = index;
  const head = [...new Uint8Array(Uint32Array.of(sepEnd.length).buffer)];
  sepEnd.forEach((end, b) => {
    for (let v of [end - (sepEnd[b - 1] ?? 0), blockStart[b + 1]! - blockStart[b]!]) {
      for (; v >= 0x80; v = Math.floor(v / 0x80)) head.push((v & 0x7f) | 0x80);
      head.push(v);
    }
  });
  const end = head.length + sepBytes.byteLength;
  const out = new Uint8Array(end + 4);
  out.set(head);
  out.set(sepBytes, head.length);
  new DataView(out.buffer).setUint32(end, crc32(out.subarray(0, end)), true);
  return out;
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
 * Encode SST version 3.
 *   data blocks (see `encodeBlock`)
 *   bloom bits
 *   footer, 24 bytes:
 *     u32 entryCount | u32 dataLen | u32 bloomHashCount
 *     u32 crc32 of every byte before it | u32 version=3 | u32 magic
 * The run holds no index: `end.index` is the one its manifest entry records.
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

  const out = new Uint8Array(dataLen + bloom.bits.byteLength + SST_FOOTER_BYTES);
  const view = new DataView(out.buffer);
  let o = 0;
  for (const blob of blockBlobs) {
    out.set(blob, o);
    o += blob.byteLength;
  }
  out.set(bloom.bits, o);
  o += bloom.bits.byteLength;

  for (const field of [sorted.length, dataLen, bloom.hashCount]) {
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
      index: indexBlob(blockIndexOf(index)),
    },
  };
}

/** `encodeRunRef`'s bytes. */
export function encodeSstRef(entries: readonly SstEntry[], blockTarget = SST_BLOCK_TARGET): Uint8Array {
  return encodeRunRef(entries, blockTarget).body;
}

/** A run's footer as `readFooter` checks it, with the field only this reference reads. */
export type FooterRef = SstFooter & { entryCount: number };

/** `tail` is the last `tail.byteLength` bytes of a `fileSize`-byte run, as for `readFooter`. */
export function footerRef(tail: Uint8Array, fileSize: number): FooterRef {
  const f = readFooter(tail, fileSize);
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  return { ...f, entryCount: view.getUint32(tail.byteLength - SST_FOOTER_BYTES, true) };
}

type RunLayout = {
  view: DataView;
  /** Where the CRC is stored. It covers every byte before it. */
  crcOff: number;
  entryCount: number;
  dataLen: number;
};

function parseFooter(buf: Uint8Array): RunLayout {
  const f = footerRef(buf, buf.byteLength);
  return {
    view: new DataView(buf.buffer, buf.byteOffset, buf.byteLength),
    crcOff: buf.byteLength - 12,
    entryCount: f.entryCount,
    dataLen: f.dataLen,
  };
}

/**
 * The length of the block that starts at `start`, which a reader of bare
 * bytes has no index for: its header, the records the header counts, then
 * its offset table. Nothing of it may reach `limit`, where the data ends.
 */
export function blockLength(buf: Uint8Array, view: DataView, start: number, limit: number): number {
  let o = start;
  const skip = (n: number): number => {
    if (o + n > limit) throw new CorruptDatabaseError("sst block OOB");
    o += n;
    return o - n;
  };
  const varint = (): number => {
    let v = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const b = buf[skip(1)]!;
      v += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) return v;
    }
    throw new CorruptDatabaseError("sst bad varint");
  };
  const count = view.getUint32(skip(4), true);
  skip(varint());
  for (let i = 0; i < count; i++) {
    const tag = buf[skip(9)];
    skip(varint());
    if (tag === TAG_PUT) skip(varint());
    else if (tag !== TAG_DEL) throw new CorruptDatabaseError(`bad sst tag ${tag}`);
  }
  skip(offsetTableBytes(count));
  return o - start;
}

type Block = { offset: number; length: number; entries: SstEntry[] };

/** Every block of a run's data, `buf[0, dataLen)`, found front to back and decoded. */
function readBlocks(buf: Uint8Array, view: DataView, dataLen: number): Block[] {
  const blocks: Block[] = [];
  for (let offset = 0; offset < dataLen; ) {
    const length = blockLength(buf, view, offset, dataLen);
    blocks.push({ offset, length, entries: walkBlock(blockBytes(buf, view, offset, length)) });
    offset += length;
  }
  return blocks;
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

/** Every entry of a whole run file, read with no index: the CRC, then each block where the one before it ends. */
export function decodeSst(buf: Uint8Array): SstEntry[] {
  const meta = parseFooter(buf);
  if (crc32(buf.subarray(0, meta.crcOff)) !== meta.view.getUint32(meta.crcOff, true)) {
    throw new CorruptDatabaseError("sst crc mismatch");
  }
  const out = readBlocks(buf, meta.view, meta.dataLen).flatMap((block) => block.entries);
  if (out.length !== meta.entryCount) {
    throw new CorruptDatabaseError("sst entry count mismatch");
  }
  return out;
}

/** The first and last key of each block of a whole run file, and where the block is. */
function blockIndexEntries(buf: Uint8Array): BlockIndexEntry[] {
  const meta = parseFooter(buf);
  const none = new Uint8Array(0);
  return readBlocks(buf, meta.view, meta.dataLen).map(({ offset, length, entries }) => ({
    firstKey: entries[0]?.key ?? none,
    lastKey: entries[entries.length - 1]?.key ?? none,
    offset,
    length,
  }));
}

/** The block index of a whole run file, rebuilt from its blocks. Encoders report the same index, encoded as `indexBlob` does, in `RunEnd`. */
export function sstBlockIndex(buf: Uint8Array): BlockIndex {
  return blockIndexOf(blockIndexEntries(buf));
}

/**
 * The smallest and largest key of a whole run file, read from its blocks, or
 * undefined for an empty run. Encoders report the same range in `RunEnd`.
 */
export function sstKeyRange(buf: Uint8Array): KeyRange | undefined {
  if (parseFooter(buf).entryCount === 0) return undefined;
  const index = blockIndexEntries(buf);
  const first = index[0];
  const last = index[index.length - 1];
  return first && last ? { smallest: first.firstKey, largest: last.lastKey } : undefined;
}

/**
 * What an encoder reports at the end of a whole run file, rebuilt from its
 * bytes: what the run's manifest entry records, for a reader of bare bytes.
 */
export function sstRunEnd(buf: Uint8Array): RunEnd {
  const range = sstKeyRange(buf);
  return { bytes: buf.byteLength, ...(range && { range }), index: indexBlob(sstBlockIndex(buf)) };
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

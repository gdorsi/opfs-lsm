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
const FOOTER_V5 = 40;
const FOOTER_BYTES = 44;

/**
 * How a run stores its data blocks. An LZ4 block is a u32 uncompressed
 * length followed by LZ4 block-format bytes.
 */
export type SstCodec = "raw" | "lz4";
const CODECS: readonly SstCodec[] = ["raw", "lz4"];

function isBlockVersion(version: number): boolean {
  return version >= VERSION_V2 && version <= VERSION_V6;
}

/**
 * v5 and v6 keep their magic and version in the last 8 bytes. Older
 * versions keep them in the first 8. v2 to v4 end with a block length,
 * which is 4 or at least 9, then the CRC. A v1 run passes for v5 or v6 only
 * if its CRC equals the magic.
 */
function sstVersion(buf: Uint8Array, view: DataView): number {
  const n = buf.byteLength;
  if (n >= FOOTER_V5 && view.getUint32(n - 4, true) === SST_MAGIC) {
    const version = view.getUint32(n - 8, true);
    const footer = version === VERSION_V6 ? FOOTER_BYTES : FOOTER_V5;
    if ((version === VERSION_V5 || version === VERSION_V6) && n >= footer) return version;
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

export function entryRecordSize(e: SstEntry): number {
  let n = 1 + 8 + 4 + e.key.byteLength;
  if (e.kind === "put") n += 4 + e.value.byteLength;
  return n;
}

function writeRecords(
  out: Uint8Array,
  view: DataView,
  o: number,
  entries: readonly SstEntry[],
): number {
  for (const e of entries) {
    out[o++] = e.kind === "put" ? TAG_PUT : TAG_DEL;
    view.setBigUint64(o, BigInt(e.seq ?? 0), true);
    o += 8;
    view.setUint32(o, e.key.byteLength, true);
    o += 4;
    out.set(e.key, o);
    o += e.key.byteLength;
    if (e.kind === "put") {
      view.setUint32(o, e.value.byteLength, true);
      o += 4;
      out.set(e.value, o);
      o += e.value.byteLength;
    }
  }
  return o;
}

function readRecords(
  buf: Uint8Array,
  view: DataView,
  start: number,
  end: number,
  count: number,
  withSeq: boolean,
): SstEntry[] {
  const out: SstEntry[] = [];
  let o = start;
  for (let i = 0; i < count; i++) {
    if (o >= end) throw new CorruptDatabaseError("sst truncated");
    const tag = buf[o++]!;
    let seq = 0;
    if (withSeq) {
      seq = Number(view.getBigUint64(o, true));
      o += 8;
    }
    const keyLen = view.getUint32(o, true);
    o += 4;
    if (o + keyLen > end) throw new CorruptDatabaseError("sst key OOB");
    const key = buf.slice(o, o + keyLen);
    o += keyLen;
    if (tag === TAG_PUT) {
      const valLen = view.getUint32(o, true);
      o += 4;
      if (o + valLen > end) throw new CorruptDatabaseError("sst value OOB");
      const value = buf.slice(o, o + valLen);
      o += valLen;
      out.push({ kind: "put", key, value, seq });
    } else if (tag === TAG_DEL) {
      out.push({ kind: "del", key, seq });
    } else {
      throw new CorruptDatabaseError(`bad sst tag ${tag}`);
    }
  }
  if (o !== end) throw new CorruptDatabaseError("sst block trailing");
  return out;
}

/**
 * Encode SST v6 with raw blocks. LZ4 blocks come only from the wasm encoder.
 *   data blocks (each: u32 count | records of u8 tag | u64 seq | key | value?)
 *   bloom bits
 *   index (each: u32 firstLen|key | u32 lastLen|key | u32 offset | u32 length)
 *   footer, 44 bytes:
 *     u32 entryCount | u32 blockCount | u32 bloomOffset | u32 bloomLen
 *     u32 bloomHashCount | u32 indexOffset | u32 indexLen | u32 codec
 *     u32 crc32 of every byte before it | u32 version=6 | u32 magic
 */
export function encodeSst(
  entries: readonly SstEntry[],
  blockTarget = SST_BLOCK_TARGET,
): Uint8Array {
  const sorted = [...entries].sort((a, b) => compareBytes(a.key, b.key));
  const blocks: SstEntry[][] = [];
  let cur: SstEntry[] = [];
  let curSize = 4; // block count header
  for (const e of sorted) {
    const need = entryRecordSize(e);
    if (cur.length > 0 && curSize + need > blockTarget) {
      blocks.push(cur);
      cur = [];
      curSize = 4;
    }
    cur.push(e);
    curSize += need;
  }
  if (cur.length > 0 || blocks.length === 0) blocks.push(cur);

  const bloom = createBloom(Math.max(1, sorted.length));
  for (const e of sorted) bloomAdd(bloom, e.key);

  const blockBlobs: Uint8Array[] = [];
  const index: BlockIndexEntry[] = [];
  let dataLen = 0;
  for (const block of blocks) {
    const size = 4 + block.reduce((n, e) => n + entryRecordSize(e), 0);
    const blob = new Uint8Array(size);
    const view = new DataView(blob.buffer);
    view.setUint32(0, block.length, true);
    writeRecords(blob, view, 4, block);
    index.push({
      firstKey: block[0]?.key ?? new Uint8Array(0),
      lastKey: block[block.length - 1]?.key ?? new Uint8Array(0),
      offset: dataLen,
      length: size,
    });
    blockBlobs.push(blob);
    dataLen += size;
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
  view.setUint32(o + 4, VERSION_V6, true);
  view.setUint32(o + 8, SST_MAGIC, true);
  return out;
}

function decodeSstV1(buf: Uint8Array, view: DataView, crcOff: number): SstEntry[] {
  const count = view.getUint32(8, true);
  return readRecords(buf, view, 12, crcOff, count, false);
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

/** v5 and v6 share a footer. v6 adds the codec after the index length. */
function parseFooterLayout(buf: Uint8Array, version: number): BlockLayout {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const fields = version === VERSION_V6 ? 8 : 7;
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

function decodeBlock(
  buf: Uint8Array,
  view: DataView,
  dataStart: number,
  ix: BlockIndexEntry,
  withSeq: boolean,
  codec: SstCodec,
): SstEntry[] {
  const start = dataStart + ix.offset;
  const end = start + ix.length;
  if (end > buf.byteLength || ix.length < 4) throw new CorruptDatabaseError("sst block OOB");
  if (codec === "raw") {
    return readRecords(buf, view, start + 4, end, view.getUint32(start, true), withSeq);
  }
  const block = lz4Decompress(buf.subarray(start + 4, end), view.getUint32(start, true));
  if (block.byteLength < 4) throw new CorruptDatabaseError("sst block too short");
  const blockView = new DataView(block.buffer);
  return readRecords(block, blockView, 4, block.byteLength, blockView.getUint32(0, true), withSeq);
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
      ...decodeBlock(buf, meta.view, meta.dataStart, ix, version >= VERSION_V3, meta.codec),
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

  /** Point lookup without decoding every block. The block is not retained. */
  get(key: Uint8Array): SstEntry | undefined {
    if (this.version === VERSION_V1) {
      return sstGet(this.v1Entries!, key);
    }
    if (!this.mightContain(key)) return undefined;
    const bi = this.findBlock(key);
    if (bi < 0) return undefined;
    return sstGet(this.loadBlock(bi), key);
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

  private loadBlock(i: number): SstEntry[] {
    return decodeBlock(
      this.buf,
      this.view,
      this.dataStart,
      this.index[i]!,
      this.version >= VERSION_V3,
      this.codec,
    );
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

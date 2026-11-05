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

/** Magic ASCII "OLST" (opfs-lsm SST). */
export const SST_MAGIC = 0x4f4c5354;
const VERSION_V1 = 1;
const VERSION_V2 = 2;
/** v2 layout, with a u64 seq after each record's tag. */
const VERSION_V3 = 3;
/** v3 with u32 Bloom header fields, so a filter can pass 64 KiB. */
const VERSION_V4 = 4;

function isBlockVersion(version: number): boolean {
  return version === VERSION_V2 || version === VERSION_V3 || version === VERSION_V4;
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
 * Encode SST v4: multi-block data + Bloom + block index.
 * Layout:
 *   u32 magic | u32 version=4 | u32 entryCount | u32 blockCount | u32 dataLen
 *   u32 bloomHashCount | u32 bloomByteLen | bloom
 *   data blocks (each: u32 count | records of u8 tag | u64 seq | key | value?)
 *   index (each: u32 firstLen|key | u32 lastLen|key | u32 offset | u32 length)
 *   u32 crc32
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

  const header = 20; // magic..dataLen
  const bloomHeader = 8;
  const total =
    header +
    bloomHeader +
    bloom.bits.byteLength +
    dataLen +
    indexSize +
    4;

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let o = 0;
  view.setUint32(o, SST_MAGIC, true);
  o += 4;
  view.setUint32(o, VERSION_V4, true);
  o += 4;
  view.setUint32(o, sorted.length, true);
  o += 4;
  view.setUint32(o, blocks.length, true);
  o += 4;
  view.setUint32(o, dataLen, true);
  o += 4;
  view.setUint32(o, bloom.hashCount, true);
  o += 4;
  view.setUint32(o, bloom.bits.byteLength, true);
  o += 4;
  out.set(bloom.bits, o);
  o += bloom.bits.byteLength;

  for (const blob of blockBlobs) {
    out.set(blob, o);
    o += blob.byteLength;
  }

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

  const sum = crc32(out.subarray(0, o));
  view.setUint32(o, sum, true);
  return out;
}

function decodeSstV1(buf: Uint8Array, view: DataView, crcOff: number): SstEntry[] {
  const count = view.getUint32(8, true);
  return readRecords(buf, view, 12, crcOff, count, false);
}

function parseV2Meta(buf: Uint8Array, version: number): {
  view: DataView;
  crcOff: number;
  entryCount: number;
  blockCount: number;
  dataLen: number;
  bloom: BloomFilter;
  dataStart: number;
  indexStart: number;
} {
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
  };
}

function readV2Index(
  buf: Uint8Array,
  view: DataView,
  indexStart: number,
  crcOff: number,
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
  if (o !== crcOff) throw new CorruptDatabaseError("sst v2 index trailing");
  return index;
}

function decodeBlock(
  buf: Uint8Array,
  view: DataView,
  dataStart: number,
  ix: BlockIndexEntry,
  withSeq: boolean,
): SstEntry[] {
  const start = dataStart + ix.offset;
  const end = start + ix.length;
  const count = view.getUint32(start, true);
  return readRecords(buf, view, start + 4, end, count, withSeq);
}

export function decodeSst(buf: Uint8Array): SstEntry[] {
  if (buf.byteLength < 16) {
    throw new CorruptDatabaseError("sst too short");
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== SST_MAGIC) {
    throw new CorruptDatabaseError(`bad sst magic ${magic.toString(16)}`);
  }
  const version = view.getUint32(4, true);
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

  const meta = parseV2Meta(buf, version);
  if (crc32(buf.subarray(0, meta.crcOff)) !== meta.view.getUint32(meta.crcOff, true)) {
    throw new CorruptDatabaseError("sst crc mismatch");
  }
  const index = readV2Index(
    buf,
    meta.view,
    meta.indexStart,
    meta.crcOff,
    meta.blockCount,
  );
  const out: SstEntry[] = [];
  for (const ix of index) {
    out.push(...decodeBlock(buf, meta.view, meta.dataStart, ix, version >= VERSION_V3));
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

  constructor(buf: Uint8Array) {
    if (buf.byteLength < 16) throw new CorruptDatabaseError("sst too short");
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const magic = this.view.getUint32(0, true);
    if (magic !== SST_MAGIC) {
      throw new CorruptDatabaseError(`bad sst magic ${magic.toString(16)}`);
    }
    this.version = this.view.getUint32(4, true);
    if (this.version === VERSION_V1) {
      this.v1Entries = decodeSst(buf);
      return;
    }
    if (!isBlockVersion(this.version)) {
      throw new CorruptDatabaseError(`unsupported sst version ${this.version}`);
    }
    const meta = parseV2Meta(buf, this.version);
    this.bloom = meta.bloom;
    this.dataStart = meta.dataStart;
    this.index = readV2Index(
      buf,
      meta.view,
      meta.indexStart,
      meta.crcOff,
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
    if (!first || !last || this.index.every((ix) => ix.length <= 4)) return undefined;
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

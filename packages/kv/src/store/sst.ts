import { CorruptDatabaseError } from "../errors.js";
import type { Seq } from "../seq.js";
import { crc32 } from "./crc32.js";
import { BlockEntry, NO_PREFIX, seqIn } from "./cursor.js";

/** Magic ASCII "OLST" (opfs-lsm SST). Version and magic sit in the last 8 bytes. */
const SST_MAGIC = 0x4f4c5354;
const VERSION = 3;
export const SST_FOOTER_BYTES = 24;
/**
 * The most Bloom hashes a footer may name. The encoder writes 7; a get
 * loops once per hash, so a corrupt count must not set its cost.
 */
const MAX_BLOOM_HASHES = 32;

export const TAG_PUT = 1;
export const TAG_DEL = 2;

/**
 * A block stores the offset of every `OFFSET_STRIDE`th record after
 * the first, so a get binary-searches them and walks at most
 * `OFFSET_STRIDE - 1` records. `packages/kv/engine/sst.ts` uses the
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
      readonly seq: Seq;
    }
  | { readonly kind: "del"; readonly key: Uint8Array; readonly seq: Seq };

/** The smallest and largest key of a run. */
export type KeyRange = {
  readonly smallest: Uint8Array;
  readonly largest: Uint8Array;
};

/**
 * Where a run's blocks are and which keys each holds: all a reader needs to
 * pick the block of a key. Flat arrays, with no object per block. Block i
 * holds keys in `[sep(i), sep(i + 1))`.
 */
export type BlockIndex = {
  /** `sep(i)` is `sepBytes[sepEnd[i - 1] ?? 0, sepEnd[i])`: the shortest prefix of block i's first key above block i-1's last key. */
  readonly sepBytes: Uint8Array;
  readonly sepEnd: Uint32Array;
  /** File offset of block i; `blockStart[blocks]` is the end of the data, where the Bloom filter starts. */
  readonly blockStart: Uint32Array;
};

/**
 * What an encoder reports when a run ends, and what the manifest records, so
 * nobody reads a run back for its size, its keys or its blocks.
 */
export type RunEnd = {
  /** Bytes of the whole run file. */
  readonly bytes: number;
  /** Undefined for an empty run, which has no keys. */
  readonly range?: KeyRange;
  /**
   * The run's block index, the only one there is: the run file holds none.
   * It is u32 blocks, each block's separator length and byte length as
   * varints, the separators, then a CRC-32 of all of it: `BlockIndex` less
   * its prefix sums. A reader checks it with `decodeIndex` when it first
   * needs it.
   */
  readonly index: Uint8Array;
};

/**
 * The `BlockIndex` of the index an encoder reported for a run of `bytes`
 * bytes. A manifest holds it as bytes it has not read, so every check is
 * here: the CRC, the block count the bytes can hold, varints, blocks that end
 * inside the run, and nothing after the separators. Throws
 * `CorruptDatabaseError`.
 */
export function decodeIndex(blob: Uint8Array, bytes: number): BlockIndex {
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const end = blob.byteLength - 4;
  const bad = (): never => {
    throw new CorruptDatabaseError("sst index");
  };
  if (end < 4 || crc32(blob.subarray(0, end)) !== view.getUint32(end, true)) bad();
  const blocks = view.getUint32(0, true);
  // A block takes two bytes at least, so a count the bytes cannot hold sizes no array.
  if (blocks * 2 > end - 4) bad();
  let o = 4;
  // A read past the bytes gives no byte, which ends no varint.
  const varint = (): number => {
    let v = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const b = blob[o++]!;
      v += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) return v;
    }
    return bad();
  };
  const sepEnd = new Uint32Array(blocks);
  const blockStart = new Uint32Array(blocks + 1);
  let seps = 0;
  let start = 0;
  for (let b = 0; b < blocks; b++) {
    sepEnd[b] = seps += varint();
    blockStart[b + 1] = start += varint();
  }
  if (start > bytes || o + seps !== end) bad();
  return { sepBytes: blob.subarray(o, end), sepEnd, blockStart };
}

/** A run's bytes and its `RunEnd`. */
export type EncodedRun = {
  readonly body: Uint8Array;
  readonly end: RunEnd;
};

/**
 * Walks the records of one block in place. `next` reads the record at `o`
 * into the fields, so a reader copies out only what it keeps. Keys are the
 * block's `prefixLen` bytes at `prefixAt`, then the record's suffix.
 */
export class RecordWalker {
  tag = 0;
  seqAt = 0;
  keyAt = 0;
  keyLen = 0;
  valAt = 0;
  valLen = 0;
  private prefix: Uint8Array | undefined = undefined;

  readonly buf: Uint8Array;
  readonly view: DataView;
  readonly start: number;
  readonly count: number;
  readonly prefixAt: number;
  readonly prefixLen: number;
  /** Where the records end and the offset table starts. */
  readonly end: number;
  o: number;

  /** One block: u32 count, varint prefix length, prefix, then records. */
  constructor(b: BlockBytes) {
    this.buf = b.buf;
    this.view = b.view;
    this.start = b.start;
    this.o = b.start + 4;
    this.count = b.view.getUint32(b.start, true);
    this.end = b.end - offsetTableBytes(this.count);
    this.prefixLen = this.len();
    this.prefixAt = this.o;
    if ((this.o += this.prefixLen) > this.end) throw new CorruptDatabaseError("sst prefix OOB");
  }

  /** Where record `j * OFFSET_STRIDE` starts, for `j >= 1`, from the block's offset table. */
  sampleAt(j: number): number {
    const o = this.start + this.view.getUint16(this.end + 2 * (j - 1), true);
    if (o <= this.prefixAt + this.prefixLen || o >= this.end) throw new CorruptDatabaseError("sst offset OOB");
    return o;
  }

  /** Reads the record at `o`. Gets walk a block with this, so lengths under 16 KiB skip `len`. */
  next(): void {
    const buf = this.buf;
    let o = this.o;
    if (o >= this.end) throw new CorruptDatabaseError("sst truncated");
    const tag = buf[o]!;
    this.seqAt = o + 1;
    o += 9;
    let n = buf[o]!;
    if (n < 0x80) o++;
    else if (buf[o + 1]! < 0x80) {
      n = (n & 0x7f) | (buf[o + 1]! << 7);
      o += 2;
    } else {
      this.o = o;
      n = this.len();
      o = this.o;
    }
    this.keyAt = o;
    this.keyLen = n;
    o += n;
    if (tag === TAG_PUT) {
      n = buf[o]!;
      if (n < 0x80) o++;
      else if (buf[o + 1]! < 0x80) {
        n = (n & 0x7f) | (buf[o + 1]! << 7);
        o += 2;
      } else {
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

  seq(): Seq {
    return seqIn(this.buf, this.seqAt);
  }

  /** The block's prefix as one view, made once for all its records. */
  private prefixBytes(): Uint8Array {
    return (this.prefix ??= this.prefixLen === 0 ? NO_PREFIX : this.buf.subarray(this.prefixAt, this.prefixAt + this.prefixLen));
  }

  /** Whether the record is a put. */
  isPut(): boolean {
    return this.tag === TAG_PUT;
  }

  /** The value where it is in the block. */
  valueInPlace(): Uint8Array {
    return this.buf.subarray(this.valAt, this.valAt + this.valLen);
  }

  /** The record as a scan entry: its key and its value left where they are in the block. */
  inPlace(): BlockEntry {
    return new BlockEntry(
      this.buf,
      this.tag === TAG_PUT ? "put" : "del",
      this.seqAt,
      this.valAt,
      this.valLen,
      this.prefixBytes(),
      this.keyAt,
      this.keyLen,
    );
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

export type SstFooter = {
  /** Data blocks are `[0, dataLen)`; the Bloom bits run from here to the footer. */
  dataLen: number;
  bloomHashCount: number;
};

/**
 * Where a run keeps its Bloom filter. The footer is u32 entry count, data
 * length and Bloom hash count, then CRC, version, and magic. Rejects any
 * other version. `tail` is the last `tail.byteLength` bytes of a
 * `fileSize`-byte run.
 */
export function readFooter(tail: Uint8Array, fileSize: number): SstFooter {
  if (tail.byteLength < SST_FOOTER_BYTES || fileSize < tail.byteLength) throw new CorruptDatabaseError("sst too short");
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  const magic = view.getUint32(tail.byteLength - 4, true);
  if (magic !== SST_MAGIC) throw new CorruptDatabaseError(`bad sst magic ${magic.toString(16)}`);
  const version = view.getUint32(tail.byteLength - 8, true);
  if (version !== VERSION) throw new CorruptDatabaseError(`unsupported sst version ${version}`);
  const at = tail.byteLength - SST_FOOTER_BYTES;
  // The first field, the entry count, is for a merge, which reads every entry.
  const dataLen = view.getUint32(at + 4, true);
  const bloomHashCount = view.getUint32(at + 8, true);
  if (dataLen > fileSize - SST_FOOTER_BYTES) throw new CorruptDatabaseError("sst footer sections OOB");
  if (bloomHashCount > MAX_BLOOM_HASHES) throw new CorruptDatabaseError(`sst bloom hash count ${bloomHashCount}`);
  return { dataLen, bloomHashCount };
}

/** One block's bytes: a u32 record count at `start`, then records up to `end`. */
export type BlockBytes = { buf: Uint8Array; view: DataView; start: number; end: number };

export function blockBytes(buf: Uint8Array, view: DataView, start: number, length: number): BlockBytes {
  const end = start + length;
  if (end > buf.byteLength || length < 4) throw new CorruptDatabaseError("sst block OOB");
  return { buf, view, start, end };
}

/** `buf[at, at + len)` compared with `key` from `from` on, like `compareBytes`. */
export function compareAt(buf: Uint8Array, at: number, len: number, key: Uint8Array, from: number): number {
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
 * A walker that has just read the record for `key` in one block, or
 * undefined. Checks the block prefix once, then compares suffixes in place,
 * and copies nothing: the caller takes what it needs from the walker.
 */
export function findInBlock(b: BlockBytes, key: Uint8Array): RecordWalker | undefined {
  const w = new RecordWalker(b);
  const p = w.prefixLen;
  if (key.byteLength < p) return undefined;
  for (let i = 0; i < p; i++) if (w.buf[w.prefixAt + i] !== key[i]) return undefined;
  if (seekSuffix(w, key) === 0) return undefined;
  w.next();
  return compareAt(w.buf, w.keyAt, w.keyLen, key, p) === 0 ? w : undefined;
}

/**
 * A step through the records of one block in key order, from the first key at
 * or after `seek` to the last one below `stop`, each as
 * `RecordWalker.inPlace` gives it. A bound is found by one search of the
 * block, so no record is compared with it.
 */
export function blockEntries(b: BlockBytes, seek?: Uint8Array, stop?: Uint8Array): () => BlockEntry | undefined {
  const w = new RecordWalker(b);
  let left = (seek ? seekInBlock(w, seek) : w.count) - (stop ? seekInBlock(new RecordWalker(b), stop) : 0);
  return () => {
    if (left <= 0) return undefined;
    left--;
    w.next();
    return w.inPlace();
  };
}

/**
 * Like `blockEntries`, from the last record below `seek` down to the first
 * one at or after `stop`. It reads one sampled group of `OFFSET_STRIDE`
 * records at a time, from the last group back, so a scan that stops early
 * reads only the groups it reached.
 */
export function reverseBlockEntries(b: BlockBytes, seek?: Uint8Array, stop?: Uint8Array): () => BlockEntry | undefined {
  const w = new RecordWalker(b);
  const first = w.o;
  const floor = stop ? w.count - seekInBlock(new RecordWalker(b), stop) : 0;
  let left = seek ? w.count - seekInBlock(w, seek) : w.count;
  const group: BlockEntry[] = [];
  return () => {
    if (group.length === 0 && left > floor) {
      const g = ((left - 1) / OFFSET_STRIDE) | 0;
      w.o = g === 0 ? first : w.sampleAt(g);
      for (let i = g * OFFSET_STRIDE; i < left; i++) {
        w.next();
        if (i >= floor) group.push(w.inPlace());
      }
      left = g * OFFSET_STRIDE;
    }
    return group.pop();
  };
}

import { CorruptDatabaseError } from "../errors.js";
import { asSeq, type Seq } from "../seq.js";
import { BlockEntry } from "./cursor.js";
import { lz4Decompress } from "./lz4.js";

/** Magic ASCII "OLST" (opfs-lsm SST). Version and magic sit in the last 8 bytes. */
const SST_MAGIC = 0x4f4c5354;
const VERSION = 1;
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

/** The u64 seq at `o`, read as two u32 halves, which is exact below 2^53 and allocates no BigInt. */
export function seqAt(view: DataView, o: number): Seq {
  return asSeq(view.getUint32(o, true) + view.getUint32(o + 4, true) * 2 ** 32);
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
    if (tag === TAG_PUT) {
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

  seq(): Seq {
    return seqAt(this.view, this.seqAt);
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

  /** A copy of the value that owns its buffer. */
  value(): Uint8Array {
    return this.buf.slice(this.valAt, this.valAt + this.valLen);
  }

  /** The record as a scan entry: its key and its value left where they are in the block. */
  inPlace(): BlockEntry {
    return new BlockEntry(
      this.buf,
      this.tag === TAG_PUT ? "put" : "del",
      this.seq(),
      this.valAt,
      this.valLen,
      this.prefixAt,
      this.prefixLen,
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
 * The record for `key` in one block, where it is, or undefined. Checks the
 * block prefix once, then compares suffixes in place, and copies nothing.
 */
export function findInBlock(b: BlockBytes, key: Uint8Array): BlockEntry | undefined {
  const w = RecordWalker.ofBlock(b);
  const p = w.prefixLen;
  if (key.byteLength < p) return undefined;
  for (let i = 0; i < p; i++) if (w.buf[w.prefixAt + i] !== key[i]) return undefined;
  if (seekSuffix(w, key) === 0) return undefined;
  w.next();
  return compareAt(w.buf, w.keyAt, w.keyLen, key, p) === 0 ? w.inPlace() : undefined;
}

/**
 * A step through the records of one block in key order, from the first key at
 * or after `seek`, each as `RecordWalker.inPlace` gives it.
 */
export function blockEntries(b: BlockBytes, seek?: Uint8Array): () => BlockEntry | undefined {
  const w = RecordWalker.ofBlock(b);
  let left = seek ? seekInBlock(w, seek) : w.count;
  return () => {
    if (left === 0) return undefined;
    left--;
    w.next();
    return w.inPlace();
  };
}

/** Like `blockEntries`, from the last record below `seek` down. */
export function reverseBlockEntries(b: BlockBytes, seek?: Uint8Array): () => BlockEntry | undefined {
  const w = RecordWalker.ofBlock(b);
  const first = w.o;
  const below = seek ? w.count - seekInBlock(w, seek) : w.count;
  const starts: number[] = [];
  w.o = first;
  for (let i = 0; i < below; i++) {
    starts.push(w.o);
    w.next();
  }
  return () => {
    const at = starts.pop();
    if (at === undefined) return undefined;
    w.o = at;
    w.next();
    return w.inPlace();
  };
}

import { CorruptDatabaseError } from "../errors.js";
import { asSeq, type Seq } from "../seq.js";
import type { LayerEntry } from "./cursor.js";
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
/** Bytes of an index entry after its two keys: u32 offset, u32 length, and u16 plus, minus and unknown. */
export const INDEX_ROW_TAIL = 14;
/** The smallest index entry: two u32 key lengths and the tail. */
const MIN_INDEX_ENTRY_BYTES = 8 + INDEX_ROW_TAIL;

/**
 * How a run stores its data blocks. An LZ4 block is a u32 uncompressed
 * length followed by LZ4 block-format bytes.
 */
export type SstCodec = "raw" | "lz4";
const CODECS: readonly SstCodec[] = ["raw", "lz4"];

const TAG_PUT = 1;
const TAG_DEL = 2;
/** A tag is the kind in bits 0 and 1 and `Was` in bits 2 and 3: 0 unknown, 1 absent, 2 present. */
const TAG_KIND = 3;
const WAS: readonly (Was | undefined)[] = [undefined, "absent", "present"];

/**
 * Whether a key was live just before the oldest write a record stands for.
 * A writer that read the key says so, and a blind write leaves it undefined.
 *
 * With it a record states what it does to the number of live keys: a put
 * over an absent key adds one, a delete of a present key takes one away,
 * and the other two change nothing. Summed over every record of a key, in
 * any set of sources that holds each version once, that is 1 for a live key
 * and 0 for a dead one, as long as every record of the key says.
 */
export type Was = "absent" | "present";

/** The tag bits of `was`, as a run and an entry record store them. */
export function wasBits(was: Was | undefined): number {
  return was === "absent" ? 4 : was === "present" ? 8 : 0;
}

/**
 * What records say they do to the number of live keys: `plus` put a key
 * that was absent, `minus` deleted one that was present, and `unknown` did
 * not say what held before.
 */
export type Tally = { readonly plus: number; readonly minus: number; readonly unknown: number };

/** A tally being added up. */
export class Sum {
  plus = 0;
  minus = 0;
  unknown = 0;

  add(t: Tally): this {
    this.plus += t.plus;
    this.minus += t.minus;
    this.unknown += t.unknown;
    return this;
  }

  /** Plus less minus, the live keys of a range when every source of it is summed. Undefined when the sum cannot be that number. */
  get live(): number | undefined {
    return this.unknown > 0 || this.plus < this.minus ? undefined : this.plus - this.minus;
  }

  /** One record: a put or a delete, and what it says held before. */
  count(put: boolean, was: Was | undefined): void {
    if (was === undefined) this.unknown++;
    else if (put && was === "absent") this.plus++;
    else if (!put && was === "present") this.minus++;
  }
}

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
      readonly seq: Seq;
      readonly was?: Was | undefined;
    }
  | { readonly kind: "del"; readonly key: Uint8Array; readonly seq: Seq; readonly was?: Was | undefined };

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
  /** What the run's records say, summed, so a count adds a whole run without opening it. */
  readonly tally: Tally;
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
    const kind = tag & TAG_KIND;
    if (kind === TAG_PUT) {
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
    } else if (kind === TAG_DEL) {
      this.valLen = 0;
    } else {
      throw new CorruptDatabaseError(`bad sst tag ${tag}`);
    }
    if (tag > 11) throw new CorruptDatabaseError(`bad sst tag ${tag}`);
    if (o > this.end) throw new CorruptDatabaseError("sst record OOB");
    this.tag = tag;
    this.o = o;
  }

  seq(): Seq {
    return asSeq(Number(this.view.getBigUint64(this.seqAt, true)));
  }

  isPut(): boolean {
    return (this.tag & TAG_KIND) === TAG_PUT;
  }

  was(): Was | undefined {
    return WAS[this.tag >> 2];
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

  /** The record as a scan entry: views into the block, except a key split by the block prefix. */
  inPlace(): LayerEntry {
    const { buf, keyAt, keyLen, valAt } = this;
    const key = this.prefixLen === 0 ? buf.subarray(keyAt, keyAt + keyLen) : this.key();
    const seq = this.seq();
    return this.isPut() ? { key, kind: "put", value: buf.subarray(valAt, valAt + this.valLen), seq } : { key, kind: "del", seq };
  }

  entry(): SstEntry {
    const key = this.key();
    const seq = this.seq();
    const was = this.was();
    return this.isPut() ? { kind: "put", key, value: this.value(), seq, was } : { kind: "del", key, seq, was };
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

/**
 * Adds to `sum` what the records of one block say, for the keys at or after
 * `start` and below `end`. Reads tags and keys in place and copies nothing.
 */
export function tallyBlock(b: BlockBytes, start: Uint8Array | undefined, end: Uint8Array | undefined, sum: Sum): void {
  const w = RecordWalker.ofBlock(b);
  const from = start ? w.count - seekInBlock(w, start) : 0;
  const to = end ? w.count - seekInBlock(RecordWalker.ofBlock(b), end) : w.count;
  for (let i = from; i < to; i++) {
    w.next();
    sum.count(w.isPut(), w.was());
  }
}

/**
 * The records of one block in key order, from the first key at or after
 * `seek`, each as `RecordWalker.inPlace` gives it.
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
    return this.w.inPlace();
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
    this.w.o = at;
    this.w.next();
    return this.w.inPlace();
  }
}

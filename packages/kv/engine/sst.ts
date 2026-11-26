/**
 * SST format, version 3 (docs/sst-format.md). Data blocks first, then the
 * bloom filter and a 24-byte footer. Each block stores its shared key prefix
 * once; records hold the suffix and use varint lengths. A run holds no index
 * of its blocks: its writer reports one, for the run's manifest entry.
 * Must stay byte-compatible with the reader in `packages/kv/src/store/sst.ts`
 * and the reference writer in `packages/kv/tests/oracle/sst-ref.ts`.
 */
import { appendBloom, HASH_COUNT, keyHash } from "./bloom";
import { Bytes, commonPrefix, compareBytes, equalBytes } from "./buf";
import { crc32, crcUpdate } from "./crc32";

const MAGIC: u32 = 0x4f4c5354; // OLST
const VERSION: u32 = 3;
export const FOOTER_BYTES: usize = 24;
export const TAG_PUT: u8 = 1;
export const TAG_DEL: u8 = 2;
export const BLOCK_TARGET: usize = 32 << 10;
/**
 * A block stores the offset of every `OFFSET_STRIDE`th record after the
 * first, so a get binary-searches them and walks at most
 * `OFFSET_STRIDE - 1` records. `packages/kv/src/store/sst.ts` uses the same
 * stride.
 */
const OFFSET_STRIDE: usize = 4;

/** The value length of a tombstone. */
export const NO_VALUE: usize = usize.MAX_VALUE;

// The statuses of a corrupt input (abi.md, "Error codes").
export const TOO_SHORT: i32 = -1;
const BAD_MAGIC: i32 = -2;
const BAD_VERSION: i32 = -3;
export const CRC_MISMATCH: i32 = -4;
export const TRUNCATED: i32 = -5;
export const BAD_TAG: i32 = -6;
export const TRAILING_GARBAGE: i32 = -7;
export const COUNT_MISMATCH: i32 = -8;
const BAD_BLOCK: i32 = -9;
export const OUT_OF_ORDER: i32 = -13;

/** Bytes of a block's offset table: a u16 per sampled record. Only a block of one record can pass the u16 range, and it has no table. */
@inline function offsetTableBytes(count: usize): usize {
  return 2 * ((count > 0 ? count - 1 : 0) / OFFSET_STRIDE);
}

/**
 * Upper bound on an encoded record: tag, seq, and u32 lengths. On-disk
 * records use varints and a shared prefix, so they are never larger.
 * Compaction cuts runs by this without encoding them.
 */
@inline export function entrySize(keyLen: usize, valueLen: usize): usize {
  return 13 + keyLen + (valueLen == NO_VALUE ? 0 : 4 + valueLen);
}

@inline function varintLen(v: usize): usize {
  let n: usize = 1;
  while (v >= 0x80) {
    v >>= 7;
    n += 1;
  }
  return n;
}

function writeVarint(out: Bytes, v: usize): void {
  while (v >= 0x80) {
    out.push(<u8>v | 0x80);
    v >>= 7;
  }
  out.push(<u8>v);
}

/**
 * A record's bytes besides its key suffix. The suffix length varint is sized
 * from the whole key, an upper bound that stays fixed as the block prefix
 * shrinks, so a block is sized from running sums.
 * `packages/kv/tests/oracle/sst-ref.ts` sizes blocks the same way.
 */
@inline function recordOverhead(keyLen: usize, valueLen: usize): usize {
  const n: usize = 9 + varintLen(keyLen);
  return valueLen == NO_VALUE ? n : n + varintLen(valueLen) + valueLen;
}

/** What a writer reports when a run ends: what the manifest records, so nobody reads the run back for it. */
@final @unmanaged
export class RunEnd {
  /** Entries in the run, tombstones included. */
  entries: usize = 0;
  /** Bytes of the whole run, footer included. */
  size: usize = 0;
  /** The smallest and largest key. Both are empty when the run has no entries, and also when its only key is empty, so `entries` says which. */
  firstKey: Bytes = new Bytes();
  lastKey: Bytes = new Bytes();
  /** The run's index (abi.md, "Wire formats") between its block count and its CRC: each block's two lengths, then the separators. */
  blocks: usize = 0;
  lens: Bytes = new Bytes();
  seps: Bytes = new Bytes();

  /** Write the run head (abi.md, "Wire formats") at `at`. */
  storeHead(at: usize): void {
    store<u32>(at, <u32>this.entries);
    store<u32>(at, <u32>this.size, 4);
    store<u32>(at, <u32>this.firstKey.len, 8);
    store<u32>(at, <u32>this.lastKey.len, 12);
  }

  /** Append what follows a run head: the two keys, then the index. */
  appendRest(out: Bytes): void {
    out.append(this.firstKey.ptr, this.firstKey.len);
    out.append(this.lastKey.ptr, this.lastKey.len);
    const at = out.len;
    out.pushU32(<u32>this.blocks);
    out.append(this.lens.ptr, this.lens.len);
    out.append(this.seps.ptr, this.seps.len);
    out.pushU32(crc32(out.ptr + at, out.len - at));
  }

  free(): void {
    this.firstKey.free();
    this.lastKey.free();
    this.lens.free();
    this.seps.free();
    heap.free(changetype<usize>(this));
  }
}

/**
 * A record of the open block, in `Writer.recs`: u64 seq, then the bytes of
 * its key shared with the block's first key, the rest of its key, and its
 * value length. Its key is staged cut after the shared bytes, because the
 * block's prefix is only known at its last key and can only shrink. A key
 * cut here is never longer than the suffix it will be written with, so
 * staged bytes never pass the block's encoded size however long the keys.
 */
const REC: usize = 24;

/**
 * Builds one SST in file order. `push` takes entries in key order and
 * appends each data block to `out` as soon as it is cut. `finish` appends
 * the bloom filter and the footer, and reports the run with its index. While
 * a run is open the writer holds one block, 4 bytes per key for the bloom
 * filter, and the index, however large the run's data grows.
 *
 * The writer never reads `out`, so a caller can move the bytes on and clear
 * it between calls. After `finish` the writer is ready for the next run,
 * with its buffers kept.
 */
@final @unmanaged
export class Writer {
  /** The open block's first key. */
  first: Bytes = new Bytes();
  recs: Bytes = new Bytes();
  staged: Bytes = new Bytes();
  /** Sum of the open block's key lengths and `recordOverhead`s, so the cut rule is a few additions per entry. */
  keys: usize = 0;
  overhead: usize = 0;
  offsets: Bytes = new Bytes();
  hashes: Bytes = new Bytes();
  /** The index so far, as `RunEnd` reports it: per block a varint separator length and a varint byte length, and the separators. */
  lens: Bytes = new Bytes();
  seps: Bytes = new Bytes();
  /** The CRC register over the bytes emitted so far, and their count. */
  crc: u32 = ~0;
  sent: usize = 0;
  blocks: usize = 0;
  entries: usize = 0;
  firstKey: Bytes = new Bytes();
  lastKey: Bytes = new Bytes();

  /**
   * Add the next entry, a tombstone when `valueLen` is `NO_VALUE`. Keys must
   * not decrease; an equal key is accepted and written after the one before
   * it. Returns `OUT_OF_ORDER`, with the writer as it was, for a key below
   * the last.
   *
   * A block holds at most `BLOCK_TARGET` encoded bytes, or one entry. Its
   * prefix shrinks as keys join it, so its size is recomputed from running
   * key and overhead sums at each entry; when the entry would overflow it,
   * the block is cut first and appended to `out`.
   */
  push(key: usize, keyLen: usize, value: usize, valueLen: usize, seq: u64, out: Bytes): i32 {
    if (this.entries > 0 && compareBytes(key, keyLen, this.lastKey.ptr, this.lastKey.len) < 0) return OUT_OF_ORDER;
    const overhead = recordOverhead(keyLen, valueLen);
    let shared = keyLen;
    if (this.recs.len) {
      shared = commonPrefix(this.first.ptr, this.first.len, key, keyLen);
      const n = this.recs.len / REC + 1;
      const size =
        <usize>4 + varintLen(shared) + shared + this.overhead + overhead + this.keys + keyLen - n * shared + offsetTableBytes(n);
      if (size > BLOCK_TARGET) {
        this.cut(out);
        shared = keyLen;
      }
    }
    if (!this.recs.len) {
      this.first.clear();
      this.first.append(key, keyLen);
      // The block's separator: the shortest prefix of its first key above the last key before it, and the whole key for the first block.
      const sep = this.entries ? min(commonPrefix(this.lastKey.ptr, this.lastKey.len, key, keyLen) + 1, keyLen) : keyLen;
      writeVarint(this.lens, sep);
      this.seps.append(key, sep);
    }
    const recs = this.recs;
    recs.reserve(REC);
    const r = recs.ptr + recs.len;
    store<u64>(r, seq);
    store<usize>(r, shared, 8);
    store<usize>(r, keyLen - shared, 12);
    store<usize>(r, valueLen, 16);
    recs.len += REC;
    this.staged.append(key + shared, keyLen - shared);
    if (valueLen != NO_VALUE) this.staged.append(value, valueLen);
    this.keys += keyLen;
    this.overhead += overhead;
    this.hashes.pushU32(keyHash(key, keyLen));
    if (this.entries == 0) this.firstKey.append(key, keyLen);
    this.lastKey.clear();
    this.lastKey.append(key, keyLen);
    this.entries += 1;
    return 0;
  }

  /** Add the CRC of the last `n` bytes of `out`, which it just appended, to the run's. */
  @inline private sum(out: Bytes, n: usize): void {
    this.crc = crcUpdate(this.crc, out.ptr + out.len - n, n);
    this.sent += n;
  }

  /**
   * End the run: close the open block, then append the bloom filter and the
   * footer to `out`, and report the run in `end`. Together with what `push`
   * appended, `out` holds the run.
   *   data blocks | bloom bits | footer (24 bytes)
   * The footer is u32 entry count, data length and bloom hash count, then a
   * u32 CRC of every byte before it, u32 version 3 and u32 magic.
   */
  finish(out: Bytes, end: RunEnd): void {
    if (this.recs.len || this.blocks == 0) this.cut(out);
    const dataLen = this.sent;
    this.sum(out, appendBloom(out, this.hashes));
    out.pushU32(<u32>this.entries);
    out.pushU32(<u32>dataLen);
    out.pushU32(HASH_COUNT);
    this.sum(out, 12);
    out.pushU32(~this.crc);
    out.pushU32(VERSION);
    out.pushU32(MAGIC);

    end.entries = this.entries;
    end.size = this.sent + 12;
    end.blocks = this.blocks;
    end.firstKey.swap(this.firstKey);
    end.lastKey.swap(this.lastKey);
    end.lens.swap(this.lens);
    end.seps.swap(this.seps);
    this.firstKey.clear();
    this.lastKey.clear();
    this.first.clear();
    this.recs.clear();
    this.staged.clear();
    this.keys = 0;
    this.overhead = 0;
    this.hashes.clear();
    this.lens.clear();
    this.seps.clear();
    this.crc = ~0;
    this.sent = 0;
    this.blocks = 0;
    this.entries = 0;
  }

  /**
   * Write the open block, which may be empty only for a run with no entries,
   * to the end of `out`.
   *   u32 count | varint prefixLen | prefix | count records | u16 offsets
   * The prefix is the longest one shared by every key in the block, which for
   * sorted keys is the first and last key's. `offsets[j]` is where record
   * `(j + 1) * OFFSET_STRIDE` starts, from the start of the block. A record is
   *   u8 tag | u64 seq | varint suffixLen | suffix | (put) varint valLen | value
   */
  private cut(out: Bytes): void {
    const n = this.recs.len / REC;
    const p: usize = n ? load<usize>(this.recs.ptr + this.recs.len - REC, 8) : 0;
    const first = this.first.ptr;
    const start = out.len;
    const offsets = this.offsets;
    offsets.clear();
    out.pushU32(<u32>n);
    writeVarint(out, p);
    out.append(first, p);
    let at = this.staged.ptr;
    for (let i: usize = 0; i < n; i++) {
      if (i > 0 && i % OFFSET_STRIDE == 0) offsets.pushU16(<u16>(out.len - start));
      const r = this.recs.ptr + i * REC;
      const shared = load<usize>(r, 8);
      const rest = load<usize>(r, 12);
      const valueLen = load<usize>(r, 16);
      out.push(valueLen == NO_VALUE ? TAG_DEL : TAG_PUT);
      out.pushU64(load<u64>(r));
      writeVarint(out, shared - p + rest);
      out.append(first + p, shared - p);
      out.append(at, rest);
      at += rest;
      if (valueLen != NO_VALUE) {
        writeVarint(out, valueLen);
        out.append(at, valueLen);
        at += valueLen;
      }
    }
    out.append(offsets.ptr, offsets.len);

    const len = out.len - start;
    this.sum(out, len);
    // The one block of a run with no entries has no first key: its separator is empty.
    if (!n) this.lens.push(0);
    writeVarint(this.lens, len);

    this.recs.clear();
    this.staged.clear();
    this.keys = 0;
    this.overhead = 0;
    this.blocks += 1;
  }

  free(): void {
    this.first.free();
    this.recs.free();
    this.staged.free();
    this.offsets.free();
    this.hashes.free();
    this.lens.free();
    this.seps.free();
    this.firstKey.free();
    this.lastKey.free();
    heap.free(changetype<usize>(this));
  }
}

// Entry records (abi.md, "Wire formats"), as `encodeSst` reads them
// where they are: an entry is the offset of its record in the input.

@inline function keyLenAt(input: usize, e: u32): usize {
  return load<u32>(input + e, 9);
}

@inline function keyAt(input: usize, e: u32): usize {
  return input + e + 13;
}

@inline function before(input: usize, a: u32, b: u32): bool {
  return compareBytes(keyAt(input, a), keyLenAt(input, a), keyAt(input, b), keyLenAt(input, b)) < 0;
}

/** Top-down stable merge sort of the `n` entries at `v` by key, with `buf` (as long) as scratch. */
function mergeSort(input: usize, v: usize, buf: usize, n: usize): void {
  if (n <= 16) {
    for (let i: usize = 1; i < n; i++) {
      for (let j = i; j > 0; j--) {
        const a = load<u32>(v + ((j - 1) << 2));
        const b = load<u32>(v + (j << 2));
        if (!before(input, b, a)) break;
        store<u32>(v + ((j - 1) << 2), b);
        store<u32>(v + (j << 2), a);
      }
    }
    return;
  }
  const mid = n >> 1;
  mergeSort(input, v, buf, mid);
  mergeSort(input, v + (mid << 2), buf + (mid << 2), n - mid);
  if (!before(input, load<u32>(v + (mid << 2)), load<u32>(v + ((mid - 1) << 2)))) return;
  memory.copy(buf, v, n << 2);
  let i: usize = 0;
  let j = mid;
  for (let slot: usize = 0; slot < n; slot++) {
    // Ties take the left run, which keeps the sort stable.
    if (j == n || (i < mid && !before(input, load<u32>(buf + (j << 2)), load<u32>(buf + (i << 2))))) {
      store<u32>(v + (slot << 2), load<u32>(buf + (i << 2)));
      i += 1;
    } else {
      store<u32>(v + (slot << 2), load<u32>(buf + (j << 2)));
      j += 1;
    }
  }
}

/**
 * Fold the entry records of `input[..len]`, in the order they were written
 * and in any key order, into the run a flush publishes: the run holds each
 * key once, as its last entry. `out` gets a run record (abi.md,
 * "Wire formats"). Returns 0, or `TRUNCATED` or `BAD_TAG` for a malformed
 * list, with `out` empty.
 */
export function encodeSst(input: usize, len: usize, out: Bytes): i32 {
  const order = new Bytes();
  let o: usize = 0;
  while (o < len) {
    const e = o;
    const tag = load<u8>(input + o);
    o += 1;
    if (len - o < 12) return fail(order, TRUNCATED);
    const keyLen = <usize>load<u32>(input + o, 8);
    o += 12;
    if (keyLen > len - o) return fail(order, TRUNCATED);
    o += keyLen;
    if (tag == TAG_PUT) {
      if (len - o < 4) return fail(order, TRUNCATED);
      const valueLen = <usize>load<u32>(input + o);
      o += 4;
      if (valueLen > len - o) return fail(order, TRUNCATED);
      o += valueLen;
    } else if (tag != TAG_DEL) {
      return fail(order, BAD_TAG);
    }
    order.pushU32(<u32>e);
  }

  const n = order.count;
  const v = order.ptr;
  let sorted = true;
  for (let i: usize = 1; i < n && sorted; i++) sorted = !before(input, load<u32>(v + (i << 2)), load<u32>(v + ((i - 1) << 2)));
  if (!sorted) {
    const buf = heap.alloc(n << 2);
    mergeSort(input, v, buf, n);
    heap.free(buf);
  }

  // The run is written after room for its head, so it is never copied.
  out.clear();
  out.reserve(16);
  out.len = 16;
  const writer = new Writer();
  for (let i: usize = 0; i < n; i++) {
    const e = load<u32>(v + (i << 2));
    const key = keyAt(input, e);
    const keyLen = keyLenAt(input, e);
    if (i + 1 < n) {
      const next = load<u32>(v + ((i + 1) << 2));
      if (equalBytes(keyAt(input, next), keyLenAt(input, next), key, keyLen)) continue;
    }
    const put = load<u8>(input + e) == TAG_PUT;
    writer.push(key, keyLen, key + keyLen + 4, put ? <usize>load<u32>(key + keyLen) : NO_VALUE, load<u64>(input + e, 1), out);
  }
  const end = new RunEnd();
  writer.finish(out, end);
  end.storeHead(out.ptr);
  end.appendRest(out);
  end.free();
  writer.free();
  order.free();
  return 0;
}

function fail(order: Bytes, status: i32): i32 {
  order.free();
  return status;
}

/**
 * A cursor over the records of one data block:
 *   u32 count | varint prefixLen | prefix | records | u16 offsets
 * It holds offsets only, so the block may move between calls; `next` must
 * be given the bytes `start` read. Lengths are checked as `len > end - o`
 * with `o <= end`, never as `o + len > end`, which wraps for a length near
 * `u32::MAX`.
 */
@final @unmanaged
export class BlockWalk {
  o: usize = 0;
  /** Where the offset table starts, which the records must end at. */
  end: usize = 0;
  left: usize = 0;
  prefixAt: usize = 0;
  prefixLen: usize = 0;
  // The record `next` read: offsets into the block, and `valueLen` is
  // `NO_VALUE` for a tombstone.
  seq: u64 = 0;
  suffixAt: usize = 0;
  suffixLen: usize = 0;
  valueAt: usize = 0;
  valueLen: usize = 0;
  /** The varint cursor, an offset into the bytes `varint` is given. */
  at: usize = 0;

  /** Start on the `len`-byte block at `block`. Returns 0 or an error status. */
  start(block: usize, len: usize): i32 {
    if (len < 4) return TRUNCATED;
    const count = <usize>load<u32>(block);
    const table = offsetTableBytes(count);
    if (table > len) return TRUNCATED;
    const end = len - table;
    this.at = 4;
    const prefixLen = this.varint(block, end);
    if (prefixLen < 0) return <i32>prefixLen;
    if (<usize>prefixLen > end - this.at) return TRUNCATED;
    this.o = this.at + <usize>prefixLen;
    this.end = end;
    this.left = count;
    this.prefixAt = this.at;
    this.prefixLen = <usize>prefixLen;
    return 0;
  }

  /**
   * Read the next record: 1 when there is one, 0 after the last, once the
   * records are seen to end exactly where the offset table starts, or an
   * error status.
   */
  next(block: usize): i32 {
    let o = this.o;
    const end = this.end;
    if (this.left == 0) return o == end ? 0 : TRAILING_GARBAGE;
    if (o >= end) return TRUNCATED;
    const tag = load<u8>(block + o);
    o += 1;
    if (end - o < 8) return TRUNCATED;
    this.seq = load<u64>(block + o);
    this.at = o + 8;
    const keyLen = this.varint(block, end);
    if (keyLen < 0) return <i32>keyLen;
    o = this.at;
    if (<usize>keyLen > end - o) return TRUNCATED;
    this.suffixAt = o;
    this.suffixLen = <usize>keyLen;
    o += <usize>keyLen;
    if (tag == TAG_PUT) {
      this.at = o;
      const valueLen = this.varint(block, end);
      if (valueLen < 0) return <i32>valueLen;
      o = this.at;
      if (<usize>valueLen > end - o) return TRUNCATED;
      this.valueAt = o;
      this.valueLen = <usize>valueLen;
      o += <usize>valueLen;
    } else if (tag == TAG_DEL) {
      this.valueLen = NO_VALUE;
    } else {
      return BAD_TAG;
    }
    this.o = o;
    this.left -= 1;
    return 1;
  }

  /**
   * The unsigned LEB128 at the cursor, of at most 5 bytes that end before
   * `end`, or an error status. Bits past 32 are dropped, as on wasm32 Rust,
   * whose `usize` is 32 bits.
   */
  varint(block: usize, end: usize): i64 {
    let o = this.at;
    let v: u32 = 0;
    for (let shift: u32 = 0; shift < 35; shift += 7) {
      if (o >= end) return TRUNCATED;
      const b = load<u8>(block + o);
      o += 1;
      v |= (<u32>(b & 0x7f)) << shift;
      if (b < 0x80) {
        this.at = o;
        return v;
      }
    }
    return BAD_BLOCK;
  }
}

/** True when the `hn` bytes at `hay` hold the `nn` bytes at `needle` as a contiguous run. */
function contains(hay: usize, hn: usize, needle: usize, nn: usize): bool {
  if (nn == 0) return true;
  const first = load<u8>(needle);
  const rest = needle + 1;
  const restLen = nn - 1;
  const end = hay + hn;
  for (let p = hay; p < end; p++) {
    if (load<u8>(p) != first) continue;
    const at = p + 1;
    if (end - at >= restLen && memory.compare(at, rest, restLen) == 0) return true;
  }
  return false;
}

/** True when the value has every pattern of the pattern list (abi.md) `patterns[..len]`. */
function hasAll(value: usize, valueLen: usize, patterns: usize, len: usize): bool {
  let o: usize = 0;
  while (o < len) {
    const n = <usize>load<u32>(patterns + o);
    if (!contains(value, valueLen, patterns + o + 4, n)) return false;
    o += 4 + n;
  }
  return true;
}

const walk = new BlockWalk();

/**
 * The puts of one data block of a run whose value contains every pattern of
 * the checked pattern list `patterns[..patLen]`, as hit records in key
 * order. Records are read in place, so a block that misses allocates
 * nothing.
 */
export function scanBlock(block: usize, len: usize, patterns: usize, patLen: usize, out: Bytes): i32 {
  let status = walk.start(block, len);
  if (status < 0) return status;
  while (true) {
    status = walk.next(block);
    if (status <= 0) return status;
    const valueLen = walk.valueLen;
    if (valueLen == NO_VALUE) continue;
    const value = block + walk.valueAt;
    if (!hasAll(value, valueLen, patterns, patLen)) continue;
    out.pushU32(<u32>(walk.prefixLen + walk.suffixLen));
    out.pushU32(<u32>valueLen);
    out.pushU64(walk.seq);
    out.append(block + walk.prefixAt, walk.prefixLen);
    out.append(block + walk.suffixAt, walk.suffixLen);
    out.append(value, valueLen);
  }
}

/** Where the sections of a run are, as offsets into the run. Data starts at 0 and the bloom filter at `dataLen`. `crcOff` holds the CRC of every byte before it. */
@final @unmanaged
export class Layout {
  entryCount: usize = 0;
  dataLen: usize = 0;
  crcOff: usize = 0;

  /**
   * Check the `FOOTER_BYTES` at `footer`, the last of a run of `size` bytes,
   * and take where its sections are. The footer is u32 entry count, data
   * length and bloom hash count, then CRC, version, and magic. Returns 0 or
   * an error status.
   */
  read(footer: usize, size: usize): i32 {
    if (load<u32>(footer, 20) != MAGIC) return BAD_MAGIC;
    if (load<u32>(footer, 16) != VERSION) return BAD_VERSION;
    const dataLen = <usize>load<u32>(footer, 4);
    if (dataLen > size - FOOTER_BYTES) return TRUNCATED;
    this.entryCount = load<u32>(footer);
    this.dataLen = dataLen;
    this.crcOff = size - 12;
    return 0;
  }
}

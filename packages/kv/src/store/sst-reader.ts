import { compareBytes } from "../bytes.js";
import { CorruptDatabaseError } from "../errors.js";
import type { AsyncFs } from "../opfs/async-fs.js";
import { bloomMightContain, type BloomFilter } from "./bloom.js";
import { Miss, type Maybe } from "./cursor.js";
import { metaKey, pageKey, type PageCache, type Sized } from "./page-cache.js";
import { blockBytes, findInBlock, readFooter, type SstCodec, type SstEntry } from "./sst.js";

/**
 * Bytes of one cache page: whole adjacent blocks, so `page.subarray` hands
 * a block to the decoder without a copy. A block larger than this gets a
 * page of its own.
 */
export const PAGE_TARGET = 32 * 1024;
/** One read covers the footer, Bloom and index of a ~4 MB run. */
const TAIL_GUESS = 128 * 1024;

/** An immutable run file of known size. */
export type RunFile = {
  readonly size: number;
  /** Exactly `length` bytes at `offset`. */
  read(offset: number, length: number): Promise<Uint8Array>;
};

/** `path` read through `fs`, rejecting a read that returns fewer bytes than asked. */
export function runFile(fs: AsyncFs, path: string, size: number): RunFile {
  return {
    size,
    async read(offset, length) {
      const buf = await fs.read(path, offset, length);
      if (!buf) throw new CorruptDatabaseError(`sst missing: ${path}`);
      if (buf.byteLength !== length) throw new CorruptDatabaseError(`sst short read: ${path}`);
      return buf;
    },
  };
}

/**
 * A run's block index as flat arrays, with no object per block. Block i
 * holds keys in `[sep(i), sep(i + 1))`. `sep(i)` is the shortest prefix of
 * block i's first key above block i-1's last key, so a key that falls
 * between two blocks costs one block read after the Bloom filter.
 */
export type RunIndex = {
  /** `sep(i)` is `sepBytes[sepEnd[i - 1] ?? 0, sepEnd[i])`. */
  readonly sepBytes: Uint8Array;
  readonly sepEnd: Uint32Array;
  /** File offset of block i; `blockStart[blocks]` is the end of the data. */
  readonly blockStart: Uint32Array;
  /** First block of page p; `pageFirst[pages]` is the block count. */
  readonly pageFirst: Uint32Array;
  /** The run's largest key, so a key past it reads nothing. */
  readonly last: Uint8Array;
};

export type RunMeta = {
  readonly bloom: BloomFilter;
  readonly index: RunIndex;
  readonly codec: SstCodec;
  readonly entryCount: number;
};

type Page = { readonly buf: Uint8Array; readonly view: DataView };

/**
 * A run read on demand. It holds no bytes itself: its metadata and pages
 * are entries in `cache`, looked up per call, so the cache's budget covers
 * everything the run costs.
 */
export class SstReader {
  private readonly runId: number;

  constructor(
    private readonly file: RunFile,
    private readonly cache: PageCache,
  ) {
    this.runId = cache.nextRunId();
  }

  /** Misses at most twice on a cold run: metadata, then the page. */
  get(key: Uint8Array): Maybe<SstEntry | undefined> {
    const meta = this.meta();
    if (meta instanceof Miss) return meta;
    const { index } = meta;
    if (meta.entryCount === 0 || compareBytes(key, index.last) > 0) return undefined;
    if (!bloomMightContain(meta.bloom, key)) return undefined;
    const b = findBlock(index, key);
    if (b < 0) return undefined;
    const p = pageOfBlock(index, b);
    const page = this.page(meta, p);
    if (page instanceof Miss) return page;
    const from = index.blockStart[index.pageFirst[p]!]!;
    const at = index.blockStart[b]! - from;
    const length = index.blockStart[b + 1]! - index.blockStart[b]!;
    return findInBlock(blockBytes(page.buf, page.view, 0, { offset: at, length }, meta.codec), key);
  }

  /** Drops this run's cached bytes. */
  close(): void {
    this.cache.dropRun(this.runId);
  }

  private meta(): Maybe<RunMeta> {
    return this.cache.lookup(metaKey(this.runId), "meta", () => openMeta(this.file));
  }

  private page(meta: RunMeta, p: number): Maybe<Page> {
    const { blockStart, pageFirst } = meta.index;
    return this.cache.lookup(pageKey(this.runId, p), "main", async (): Promise<Sized<Page>> => {
      const from = blockStart[pageFirst[p]!]!;
      const to = blockStart[pageFirst[p + 1]!]!;
      const buf = await this.file.read(from, to - from);
      return { value: { buf, view: new DataView(buf.buffer, buf.byteOffset, buf.byteLength) }, bytes: to - from };
    });
  }
}

/**
 * Reads the footer, Bloom and index with one read when they fit in
 * `TAIL_GUESS`, else a second read for the rest. Skips the CRC, as the
 * whole-file reader does: compaction checks it.
 */
export async function openMeta(file: RunFile): Promise<Sized<RunMeta>> {
  const tail = await file.read(file.size - Math.min(file.size, TAIL_GUESS), Math.min(file.size, TAIL_GUESS));
  const f = readFooter(tail, file.size);
  const need = file.size - f.dataLen;
  let meta = tail.subarray(tail.byteLength - Math.min(need, tail.byteLength));
  if (need > tail.byteLength) {
    meta = new Uint8Array(need);
    meta.set(await file.read(f.dataLen, need - tail.byteLength));
    meta.set(tail, need - tail.byteLength);
  }
  const bloomLen = f.indexStart - f.dataLen;
  const bloom = { bits: meta.slice(0, bloomLen), hashCount: f.bloomHashCount };
  const index = packIndex(meta.subarray(bloomLen, f.indexEnd - f.dataLen), f.blockCount, f.dataLen);
  const bytes =
    bloom.bits.byteLength +
    index.sepBytes.byteLength +
    index.last.byteLength +
    index.sepEnd.byteLength +
    index.blockStart.byteLength +
    index.pageFirst.byteLength;
  return { value: { bloom, index, codec: f.codec, entryCount: f.entryCount }, bytes };
}

/**
 * Packs the on-disk index (per block: u32 len | first key, u32 len | last
 * key, u32 offset, u32 length) in one pass, checking blocks are contiguous
 * and end at `dataLen`.
 */
export function packIndex(raw: Uint8Array, blockCount: number, dataLen: number): RunIndex {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const sepBytes = new Uint8Array(raw.byteLength);
  const sepEnd = new Uint32Array(blockCount);
  const blockStart = new Uint32Array(blockCount + 1);
  const pages: number[] = [0];
  let sepLen = 0;
  let o = 0;
  let prevLast: Uint8Array | undefined;
  let pageStart = 0;
  const key = () => {
    if (o + 4 > raw.byteLength) throw new CorruptDatabaseError("sst index OOB");
    const len = view.getUint32(o, true);
    o += 4;
    if (o + len > raw.byteLength) throw new CorruptDatabaseError("sst index OOB");
    o += len;
    return raw.subarray(o - len, o);
  };
  for (let i = 0; i < blockCount; i++) {
    const first = key();
    const last = key();
    if (o + 8 > raw.byteLength) throw new CorruptDatabaseError("sst index OOB");
    const offset = view.getUint32(o, true);
    const length = view.getUint32(o + 4, true);
    o += 8;
    if (offset !== blockStart[i]) throw new CorruptDatabaseError("sst blocks not contiguous");
    const sep = prevLast ? first.subarray(0, separatorLength(prevLast, first)) : first;
    sepBytes.set(sep, sepLen);
    sepLen += sep.byteLength;
    sepEnd[i] = sepLen;
    if (i > pageStart && offset + length - blockStart[pageStart]! > PAGE_TARGET) {
      pages.push(i);
      pageStart = i;
    }
    blockStart[i + 1] = offset + length;
    prevLast = last;
  }
  if (o !== raw.byteLength) throw new CorruptDatabaseError("sst index trailing");
  if (blockStart[blockCount] !== dataLen) throw new CorruptDatabaseError("sst blocks not contiguous");
  pages.push(blockCount);
  return {
    sepBytes: sepBytes.slice(0, sepLen),
    sepEnd,
    blockStart,
    pageFirst: Uint32Array.from(pages),
    last: prevLast ? prevLast.slice() : new Uint8Array(0),
  };
}

/** Length of the shortest prefix of `first` that sorts after `prevLast`. */
function separatorLength(prevLast: Uint8Array, first: Uint8Array): number {
  const n = Math.min(prevLast.byteLength, first.byteLength);
  let i = 0;
  while (i < n && prevLast[i] === first[i]) i++;
  return Math.min(i + 1, first.byteLength);
}

/** The last block whose separator is <= `key`, or -1 when `key` sorts before every block. */
export function findBlock(index: RunIndex, key: Uint8Array): number {
  const { sepBytes, sepEnd } = index;
  let lo = 0;
  let hi = sepEnd.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const from = mid === 0 ? 0 : sepEnd[mid - 1]!;
    if (compareSep(sepBytes, from, sepEnd[mid]!, key) <= 0) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

function compareSep(bytes: Uint8Array, from: number, to: number, key: Uint8Array): number {
  const len = to - from;
  const n = Math.min(len, key.byteLength);
  for (let i = 0; i < n; i++) {
    const d = bytes[from + i]! - key[i]!;
    if (d !== 0) return d;
  }
  return len - key.byteLength;
}

function pageOfBlock(index: RunIndex, block: number): number {
  const { pageFirst } = index;
  let lo = 0;
  let hi = pageFirst.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pageFirst[mid]! <= block) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

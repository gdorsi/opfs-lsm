import { compareBytes } from "../bytes.js";
import { CorruptDatabaseError } from "../errors.js";
import { asSeq } from "../seq.js";
import { blockScanner, packPatterns, unpackHits } from "./block-scan.js";
import { bloomMightContain, type BloomFilter } from "./bloom.js";
import { filterCursor, Miss, type BlockEntry, type LayerCursor, type Maybe, type ScanBounds } from "./cursor.js";
import { metaKey, pageKey, type Admit, type PageCache, type Sized } from "./page-cache.js";
import {
  blockBytes,
  blockEntries,
  compareAt,
  findInBlock,
  readFooter,
  reverseBlockEntries,
  type BlockBytes,
  type KeyRange,
  type RecordWalker,
} from "./sst.js";

/**
 * Bytes of one cache page: whole adjacent blocks, so a block is read where
 * it sits in its page. A block larger than this gets a page of its own.
 */
export const PAGE_TARGET = 32 * 1024;
/** Pages a scan asks for past the one it enters, at most: 1 MiB, the longest span one read covers. */
const MAX_READ_AHEAD = 32;
/** One read covers the footer, Bloom and index of a ~4 MB run. */
const TAIL_GUESS = 128 * 1024;

/** An immutable run file of known size. `OpenFile` is one. */
type RunFile = {
  readonly size: number;
  /** Exactly `length` bytes at `offset`. */
  read(offset: number, length: number): Promise<Uint8Array>;
};

/** A run file whose bytes are already in memory, for tests and benches. */
export function bytesFile(buf: Uint8Array): RunFile {
  return { size: buf.byteLength, read: async (offset, length) => buf.subarray(offset, offset + length) };
}

/**
 * A run's block index as flat arrays, with no object per block. Block i
 * holds keys in `[sep(i), sep(i + 1))`. `sep(i)` is the shortest prefix of
 * block i's first key above block i-1's last key, so a key that falls
 * between two blocks costs one block read after the Bloom filter.
 */
type RunIndex = {
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

type RunLayout = {
  readonly bloom: BloomFilter;
  readonly index: RunIndex;
  readonly entryCount: number;
};

type Page = { readonly buf: Uint8Array; readonly view: DataView };

/**
 * A run read on demand. It holds no bytes itself: its layout and pages
 * are entries in `cache`, looked up per call, so the cache's budget covers
 * everything the run costs. Every read is sync while its bytes are
 * resident and returns a `Miss` otherwise.
 */
export class SstReader {
  private readonly runId: number;

  /**
   * `range` is undefined for a run with no keys. `marksThrough` is the one its
   * manifest entry records: the run holds no version past it. By default it
   * claims nothing, so no mark lets a scan pass the run unread.
   */
  constructor(
    private readonly file: RunFile,
    private readonly cache: PageCache,
    readonly range: KeyRange | undefined,
    readonly marksThrough = asSeq(Number.POSITIVE_INFINITY),
  ) {
    this.runId = cache.nextRunId();
  }

  /**
   * The record for `key`, where it is in its page, as `findInBlock` gives
   * it. Misses at most twice on a cold run: layout, then the page.
   */
  get(key: Uint8Array): Maybe<RecordWalker | undefined> {
    const meta = this.meta();
    if (meta instanceof Miss) return meta;
    const { index } = meta;
    if (meta.entryCount === 0 || compareBytes(key, index.last) > 0) return undefined;
    if (!bloomMightContain(meta.bloom, key)) return undefined;
    const b = findBlock(index, key);
    if (b < 0) return undefined;
    const p = pageOfBlock(index, b);
    const page = this.page(meta, p, "main");
    if (page instanceof Miss) return page;
    const at = index.blockStart[b]! - index.blockStart[index.pageFirst[p]!]!;
    const length = index.blockStart[b + 1]! - index.blockStart[b]!;
    return findInBlock(blockBytes(page.buf, page.view, 0, { offset: at, length }), key);
  }

  /** Every entry in `bounds`, in key order, or from the largest key down with `reverse`. */
  cursor(bounds?: ScanBounds, reverse = false): LayerCursor {
    const entriesOf = reverse ? reverseBlockEntries : blockEntries;
    return this.blocks(bounds, reverse, entriesOf);
  }

  /**
   * The puts in `bounds` whose value holds every pattern, in key order or
   * with `reverse` from the largest key down.
   * With the wasm engine each block is decoded and matched there and only
   * hits cross back. Without it the cursor does the same work key by key.
   */
  scanContains(patterns: readonly Uint8Array[], bounds?: ScanBounds, reverse = false): LayerCursor {
    const scan = blockScanner();
    if (!scan) return filterCursor(this.cursor(bounds, reverse), patterns);
    const packed = packPatterns(patterns);
    const outside = reverse ? isAtOrAbove : isBelow;
    return this.blocks(bounds, reverse, (block, seek) => {
      const hits = unpackHits(scan(block.buf.subarray(block.start, block.end), packed));
      const walk = reverse ? [...hits].reverse().values() : hits;
      return () => {
        for (let h = walk.next(); !h.done; h = walk.next()) {
          if (seek && outside(h.value, seek, 0)) continue;
          return h.value;
        }
        return undefined;
      };
    });
  }

  /** Drops this run's cached bytes. */
  close(): void {
    this.cache.dropRun(this.runId);
  }

  /**
   * A cursor over the blocks that may hold keys in `bounds`, in key order or
   * from the last block back. Entering a block calls `open` with its bytes,
   * and the returned function yields that block's entries. `seek` is where
   * the first block starts: `start`, or `endExclusive` going back.
   * Scans admit pages to probation. Only entering a block can miss, and a
   * miss leaves the cursor where it was.
   */
  private blocks(
    bounds: ScanBounds | undefined,
    reverse: boolean,
    open: (block: BlockBytes, seek: Uint8Array | undefined) => () => BlockEntry | undefined,
  ): LayerCursor {
    const start = bounds?.start;
    const end = bounds?.endExclusive;
    const stopAt = reverse ? start : end;
    const stop = reverse ? isBelow : isAtOrAbove;
    const step = reverse ? -1 : 1;
    let seek = reverse ? end : start;
    let b: number | undefined;
    // The page the cursor is in. Looking it up again per block would count
    // as reuse and promote every page a single scan passes.
    let at: { p: number; page: Page } | undefined;
    let take: (() => BlockEntry | undefined) | undefined;
    let cur: BlockEntry | undefined | null = null;
    let ahead: ReadAhead | undefined;
    // Whether the block the cursor is in may hold a key past `stopAt`. The
    // separators tell, so only the block the scan ends in compares its keys.
    let mayPass = false;
    // How many bytes of `stopAt` that block's prefix shares with it, so each of its keys is compared from there on. -1 until its first key asks.
    let shared = -1;
    const peek = (): BlockEntry | undefined | Miss => {
      if (cur !== null) return cur;
      for (;;) {
        const e: BlockEntry | undefined = take?.();
        if (e) {
          if (mayPass) {
            if (shared < 0) shared = e.prefixShared(stopAt!);
            cur = stop(e, stopAt!, shared) ? undefined : e;
          } else cur = e;
          return cur;
        }
        take = undefined;
        const meta = this.meta();
        if (meta instanceof Miss) return meta;
        const { index } = meta;
        const blockCount = index.sepEnd.length;
        b ??= reverse
          ? seek ? blockBelow(index, seek) : blockCount - 1
          : seek ? Math.max(0, findBlock(index, seek)) : 0;
        if (
          meta.entryCount === 0 ||
          (reverse
            ? b < 0 || (start && b + 1 < blockCount && compareSepAt(index, b + 1, start) <= 0)
            : b >= blockCount || (end && compareSepAt(index, b, end) >= 0))
        ) {
          cur = undefined;
          return cur;
        }
        const p = pageOfBlock(index, b);
        if (at?.p !== p) {
          // Not on the first page, so a scan that ends there reads no further.
          if (at) {
            ahead ??= readAhead((q) => this.page(meta, q, "probation"), lastPage(index, bounds, reverse), step);
            ahead.extend(p);
          }
          const page = ahead?.take(p) ?? this.page(meta, p, "probation");
          if (page instanceof Miss) return page;
          at = { p, page };
        }
        const { page } = at;
        const offset = index.blockStart[b]! - index.blockStart[index.pageFirst[p]!]!;
        const length = index.blockStart[b + 1]! - index.blockStart[b]!;
        // Every key of block `b` is at or after its separator and before the next block's.
        mayPass =
          !!stopAt &&
          (reverse
            ? compareSepAt(index, b, stopAt) < 0
            : b + 1 < blockCount
              ? compareSepAt(index, b + 1, stopAt) > 0
              : compareBytes(index.last, stopAt) >= 0);
        take = open(blockBytes(page.buf, page.view, 0, { offset, length }), seek);
        shared = -1;
        b += step;
        seek = undefined;
      }
    };
    return {
      peek,
      next() {
        if (cur) cur = null;
      },
    };
  }

  private meta(): Maybe<RunLayout> {
    return this.cache.lookup(metaKey(this.runId), "meta", () => openMeta(this.file));
  }

  private page(meta: RunLayout, p: number, admit: Admit): Maybe<Page> {
    const { blockStart, pageFirst } = meta.index;
    return this.cache.lookup(pageKey(this.runId, p), admit, async (): Promise<Sized<Page>> => {
      const from = blockStart[pageFirst[p]!]!;
      const to = blockStart[pageFirst[p + 1]!]!;
      const buf = await this.file.read(from, to - from);
      return { value: { buf, view: new DataView(buf.buffer, buf.byteOffset, buf.byteLength) }, bytes: to - from };
    });
  }
}

/**
 * The pages a scan asks for before it reaches them, toward `last`. When the
 * pages already asked for run within half a window of the page the scan
 * enters, it asks for every page up to a window past that one. The window
 * is one page, then twice as many each time, up to `MAX_READ_AHEAD`. What
 * one turn asks for shares one file read.
 * The scan keeps what arrives, so entering such a page is not a cache hit
 * and one pass over the data still shows no reuse.
 */
type ReadAhead = ReturnType<typeof readAhead>;

function readAhead(load: (page: number) => Maybe<Page>, last: number, step: 1 | -1) {
  const pages = new Map<number, Page>();
  let windowSize = 0;
  let asked: number | undefined;
  return {
    extend(p: number): void {
      if (asked !== undefined && (asked - p) * step > windowSize / 2) return;
      windowSize = Math.min(windowSize * 2 || 1, MAX_READ_AHEAD);
      const to = step > 0 ? Math.min(last, p + windowSize) : Math.max(last, p - windowSize);
      for (let q = (asked ?? p) + step; (to - q) * step >= 0; q += step) {
        const page = load(q);
        // A failed read is dropped here: the scan reads that page again when it reaches it.
        if (page instanceof Miss) page.ready.then((fills) => void pages.set(q, fills[0]![1] as Page), () => undefined);
        else pages.set(q, page);
        asked = q;
      }
    },
    take(p: number): Page | undefined {
      const page = pages.get(p);
      pages.delete(p);
      return page;
    },
  };
}

/** The last page a scan of `bounds` can reach: the highest going forward, the lowest going back. */
function lastPage(index: RunIndex, bounds: ScanBounds | undefined, reverse: boolean): number {
  const bound = reverse ? bounds?.start : bounds?.endExclusive;
  if (bound) return pageOfBlock(index, Math.max(0, reverse ? findBlock(index, bound) : blockBelow(index, bound)));
  return reverse ? 0 : index.pageFirst.length - 2;
}

/**
 * Reads the footer, Bloom and index with one read when they fit in
 * `TAIL_GUESS`, else a second read for the rest. Skips the CRC, which
 * would cost a pass over the whole file: compaction checks it.
 */
async function openMeta(file: RunFile): Promise<Sized<RunLayout>> {
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
  return { value: { bloom, index, entryCount: f.entryCount }, bytes };
}

/**
 * Packs the on-disk index (per block: u32 len | first key, u32 len | last
 * key, u32 offset, u32 length) in one pass, checking blocks are contiguous
 * and end at `dataLen`.
 */
function packIndex(raw: Uint8Array, blockCount: number, dataLen: number): RunIndex {
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

/** `from` is how many leading bytes of the entry's key are known to equal the bound's. */
const isBelow = (e: BlockEntry, bound: Uint8Array, from: number) => e.compareKey(bound, from) < 0;
const isAtOrAbove = (e: BlockEntry, bound: Uint8Array, from: number) => e.compareKey(bound, from) >= 0;

/**
 * The last block whose separator is <= `key`, or -1 when `key` sorts before
 * every block. Every separator between the two bounds shares with `key` the
 * bytes both bounds share with it, so a compare starts past them, as in
 * `lowerBoundKeys`.
 */
function findBlock(index: RunIndex, key: Uint8Array): number {
  const { sepBytes, sepEnd } = index;
  let lo = 0;
  let hi = sepEnd.length;
  let below = 0;
  let above = 0;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const from = mid === 0 ? 0 : sepEnd[mid - 1]!;
    const len = sepEnd[mid]! - from;
    const n = Math.min(len, key.length);
    let i = below < above ? below : above;
    while (i < n && sepBytes[from + i] === key[i]) i++;
    if (i < n ? sepBytes[from + i]! < key[i]! : len <= key.length) {
      lo = mid + 1;
      below = i;
    } else {
      hi = mid;
      above = i;
    }
  }
  return lo - 1;
}

function blockBelow(index: RunIndex, key: Uint8Array): number {
  const b = findBlock(index, key);
  return b >= 0 && compareSepAt(index, b, key) === 0 ? b - 1 : b;
}

function compareSepAt(index: RunIndex, block: number, key: Uint8Array): number {
  const from = block === 0 ? 0 : index.sepEnd[block - 1]!;
  return compareAt(index.sepBytes, from, index.sepEnd[block]! - from, key, 0);
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

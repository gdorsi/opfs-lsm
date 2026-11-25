import { compareBytes } from "../bytes.js";
import { CorruptDatabaseError } from "../errors.js";
import { asSeq } from "../seq.js";
import { blockScanner, packPatterns, unpackHits } from "./block-scan.js";
import { bloomHash, bloomMightContain, type BloomFilter } from "./bloom.js";
import { filterCursor, Miss, type BlockEntry, type LayerCursor, type Maybe, type ScanBounds } from "./cursor.js";
import { metaKey, pageKey, type Admit, type PageCache, type Sized } from "./page-cache.js";
import {
  blockBytes,
  blockEntries,
  compareAt,
  decodeIndex,
  findInBlock,
  readFooter,
  reverseBlockEntries,
  type BlockBytes,
  type BlockIndex,
  type KeyRange,
  type RecordWalker,
  type RunEnd,
} from "./sst.js";

/** Blocks a scan asks for past the one it enters, at most: 1 MiB of full blocks, the longest span one read covers. */
const MAX_READ_AHEAD = 32;

/** An immutable run file of known size. `OpenFile` is one. */
type RunFile = {
  readonly size: number;
  /** Exactly `length` bytes at `offset`. */
  read(offset: number, length: number): Promise<Uint8Array>;
  /** As `OpenFile.readSync`. */
  readSync?(offset: number, length: number): Uint8Array | undefined;
  /** As `OpenFile.syncReady`. */
  syncReady?(): boolean;
};

/** A run file whose bytes are already in memory, for tests and benches. */
export function bytesFile(buf: Uint8Array): RunFile {
  return { size: buf.byteLength, read: async (offset, length) => buf.subarray(offset, offset + length) };
}

/**
 * A run read on demand. It knows where every block is from the index its
 * manifest entry records, so no read waits for anything but the block it
 * needs. It holds no bytes of the file itself: its blocks and its Bloom
 * filter are entries in `cache`, looked up per call, so the cache's budget
 * covers them. Every read is sync while its bytes are resident, or while
 * the file answers `readSync`, and returns a `Miss` otherwise.
 */
export class SstReader {
  private readonly runId: number;
  /** Undefined for a run with no keys. */
  readonly range: KeyRange | undefined;
  private decoded: BlockIndex | undefined;
  /** Whether `file` is the size the manifest records. */
  private readonly sized: boolean;

  /**
   * `run` is what the run's manifest entry records. `marksThrough` is the
   * one that entry records: the run holds no version past it. By default it
   * claims nothing, so no mark lets a scan pass the run unread.
   */
  constructor(
    private readonly file: RunFile,
    private readonly cache: PageCache,
    private readonly run: RunEnd,
    readonly marksThrough = asSeq(Number.POSITIVE_INFINITY),
  ) {
    this.runId = cache.nextRunId();
    this.range = run.range;
    this.sized = file.size === run.bytes;
  }

  /** The run's block index, checked when first needed: opening a tab reads no run's. */
  private get index(): BlockIndex {
    return (this.decoded ??= decodeIndex(this.run.index, this.run.bytes));
  }

  /**
   * The record for `key`, where it is in its block, as `findInBlock` gives
   * it. Misses once on a cold run, on that block. The Bloom filter is asked
   * only when it is resident, and a Miss says when it was not. `hash` is
   * `bloomHash(key)`, which a read of several runs computes once.
   */
  get(key: Uint8Array, hash = bloomHash(key)): Maybe<RecordWalker | undefined> {
    const { range, index } = this;
    if (!range || compareBytes(key, range.largest) > 0) return undefined;
    const bloom = this.bloom();
    if (bloom && !bloomMightContain(bloom, hash)) return undefined;
    const b = findBlock(index, key);
    if (b < 0) return undefined;
    const block = this.block(b, "main");
    if (block instanceof Miss) return bloom ? block : new Miss(block.ready, true);
    return findInBlock(block, key);
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
   * Scans admit blocks to probation. Only entering a block can miss, and a
   * miss leaves the cursor where it was.
   */
  private blocks(
    bounds: ScanBounds | undefined,
    reverse: boolean,
    open: (block: BlockBytes, seek: Uint8Array | undefined) => () => BlockEntry | undefined,
  ): LayerCursor {
    const { range, index } = this;
    if (!range) return { peek: () => undefined, next() {} };
    const blockCount = index.sepEnd.length;
    const start = bounds?.start;
    const end = bounds?.endExclusive;
    const stopAt = reverse ? start : end;
    const stop = reverse ? isBelow : isAtOrAbove;
    const step = reverse ? -1 : 1;
    let seek = reverse ? end : start;
    let b = reverse
      ? seek ? blockBelow(index, seek) : blockCount - 1
      : seek ? Math.max(0, findBlock(index, seek)) : 0;
    let entered = false;
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
        if (
          reverse
            ? b < 0 || (start && b + 1 < blockCount && compareSepAt(index, b + 1, start) <= 0)
            : b >= blockCount || (end && compareSepAt(index, b, end) >= 0)
        ) {
          cur = undefined;
          return cur;
        }
        // Not on the first block, so a scan that ends there reads no further.
        // Not on a file that answers with no wait: there is no wait to save.
        if (entered && !this.file.syncReady?.()) {
          ahead ??= readAhead((q) => this.block(q, "probation"), lastBlock(index, bounds, reverse), step);
          ahead.extend(b);
        }
        const block = ahead?.take(b) ?? this.block(b, "probation");
        if (block instanceof Miss) return block;
        entered = true;
        // Every key of block `b` is at or after its separator and before the next block's.
        mayPass =
          !!stopAt &&
          (reverse
            ? compareSepAt(index, b, stopAt) < 0
            : b + 1 < blockCount
              ? compareSepAt(index, b + 1, stopAt) > 0
              : compareBytes(range.largest, stopAt) >= 0);
        take = open(block, seek);
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

  /**
   * The run's Bloom filter when it is resident. When it is not, its load
   * starts, and no read waits for it or fails with it: the next get asks
   * again.
   */
  private bloom(): BloomFilter | undefined {
    // One read of the rest of the file past the blocks: the filter, the index and the footer.
    // Skips the CRC, which would cost a pass over the whole file: compaction checks it.
    const bloom = this.cache.lookup(metaKey(this.runId), "meta", () => {
      const { size } = this.file;
      const from = this.index.blockStart[this.index.sepEnd.length]!;
      return this.load(from, size - from, (tail): Sized<BloomFilter> => {
        const { dataLen, indexStart, bloomHashCount: hashCount } = readFooter(tail, size);
        if (dataLen !== from) throw new CorruptDatabaseError("sst bloom OOB");
        const bits = tail.slice(0, indexStart - from);
        return { value: { bits, hashCount }, bytes: bits.byteLength };
      });
    });
    if (!(bloom instanceof Miss)) return bloom;
    bloom.ready.catch(() => undefined);
    return undefined;
  }

  private block(b: number, admit: Admit): Maybe<BlockBytes> {
    return this.cache.lookup(pageKey(this.runId, b), admit, () => {
      const { blockStart } = this.index;
      const from = blockStart[b]!;
      const bytes = blockStart[b + 1]! - from;
      return this.load(from, bytes, (buf): Sized<BlockBytes> => ({
        value: blockBytes(buf, new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 0, bytes),
        bytes,
      }));
    });
  }

  /**
   * What `decode` makes of `length` bytes at `offset`: at once when the file
   * answers with no wait, and once they are read otherwise. A failure
   * rejects either way, so a load fails the same whichever way its bytes came.
   */
  private load<T>(offset: number, length: number, decode: (bytes: Uint8Array) => T): T | Promise<T> {
    const now = this.sized ? this.file.readSync?.(offset, length) : undefined;
    if (!now) return (async () => decode(await this.read(offset, length)))();
    try {
      return decode(now);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /**
   * Every offset is the manifest's, and its blocks end inside the size it
   * records. A file of another size is not the run it describes, and a read
   * past its end would fail the reads that share its span.
   */
  private read(offset: number, length: number): Promise<Uint8Array> {
    if (!this.sized) throw new CorruptDatabaseError("sst size");
    return this.file.read(offset, length);
  }
}

/**
 * The blocks a scan asks for before it reaches them, toward `last`. When the
 * blocks already asked for run within half a window of the block the scan
 * enters, it asks for every block up to a window past that one. The window
 * is one block, then twice as many each time, up to `MAX_READ_AHEAD`. What
 * one turn asks for shares one file read.
 * The scan keeps what arrives, so entering such a block is not a cache hit
 * and one pass over the data still shows no reuse.
 */
type ReadAhead = ReturnType<typeof readAhead>;

function readAhead(load: (block: number) => Maybe<BlockBytes>, last: number, step: 1 | -1) {
  const blocks = new Map<number, BlockBytes>();
  let windowSize = 0;
  let asked: number | undefined;
  return {
    extend(b: number): void {
      if (asked !== undefined && (asked - b) * step > windowSize / 2) return;
      windowSize = Math.min(windowSize * 2 || 1, MAX_READ_AHEAD);
      const to = step > 0 ? Math.min(last, b + windowSize) : Math.max(last, b - windowSize);
      for (let q = (asked ?? b) + step; (to - q) * step >= 0; q += step) {
        const block = load(q);
        // A failed read is dropped here: the scan reads that block again when it reaches it.
        if (block instanceof Miss) block.ready.then((fills) => void blocks.set(q, fills[0]![1] as BlockBytes), () => undefined);
        else blocks.set(q, block);
        asked = q;
      }
    },
    take(b: number): BlockBytes | undefined {
      const block = blocks.get(b);
      blocks.delete(b);
      return block;
    },
  };
}

/** The last block a scan of `bounds` can reach: the highest going forward, the lowest going back. */
function lastBlock(index: BlockIndex, bounds: ScanBounds | undefined, reverse: boolean): number {
  const bound = reverse ? bounds?.start : bounds?.endExclusive;
  if (bound) return Math.max(0, reverse ? findBlock(index, bound) : blockBelow(index, bound));
  return reverse ? 0 : index.sepEnd.length - 1;
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
function findBlock(index: BlockIndex, key: Uint8Array): number {
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

function blockBelow(index: BlockIndex, key: Uint8Array): number {
  const b = findBlock(index, key);
  return b >= 0 && compareSepAt(index, b, key) === 0 ? b - 1 : b;
}

function compareSepAt(index: BlockIndex, block: number, key: Uint8Array): number {
  const from = block === 0 ? 0 : index.sepEnd[block - 1]!;
  return compareAt(index.sepBytes, from, index.sepEnd[block]! - from, key, 0);
}

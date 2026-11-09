import { compareBytes } from "../bytes.js";
import type { MemRow } from "./memtable.js";
import {
  allMissed,
  entryCursor,
  filterCursor,
  lowerBoundKeys,
  Miss,
  type LayerCursor,
  type LayerEntry,
  type Maybe,
  type ScanBounds,
} from "./cursor.js";
import type { SstEntry } from "./sst.js";
import type { SstReader } from "./sst-reader.js";
import type { Entry } from "../db.js";
import { levelOf } from "./levels.js";

type HeapItem = { key: Uint8Array; source: number };

function heapLess(a: HeapItem, b: HeapItem): boolean {
  const c = compareBytes(a.key, b.key);
  if (c !== 0) return c < 0;
  return a.source < b.source;
}

function heapGreater(a: HeapItem, b: HeapItem): boolean {
  const c = compareBytes(a.key, b.key);
  if (c !== 0) return c > 0;
  return a.source < b.source;
}

/** Binary heap. Order is `less`: key, then newer source (smaller index). */
class MinHeap {
  private readonly items: HeapItem[] = [];

  constructor(private readonly less: (a: HeapItem, b: HeapItem) => boolean) {}

  get length(): number {
    return this.items.length;
  }

  peek(): HeapItem | undefined {
    return this.items[0];
  }

  push(item: HeapItem): void {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(a[i]!, a[p]!)) break;
      const tmp = a[p]!;
      a[p] = a[i]!;
      a[i] = tmp;
      i = p;
    }
  }

  pop(): HeapItem | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length === 0) return top;
    a[0] = last;
    let i = 0;
    while (true) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < a.length && this.less(a[l]!, a[m]!)) m = l;
      if (r < a.length && this.less(a[r]!, a[m]!)) m = r;
      if (m === i) break;
      const tmp = a[m]!;
      a[m] = a[i]!;
      a[i] = tmp;
      i = m;
    }
    return top;
  }
}

/**
 * `mem` is the row from the key-ordered mem store, or undefined on miss.
 * Levels are newest-first. Returned bytes are a fresh Uint8Array.
 */
export function pointGet(
  mem: MemRow | undefined,
  levels: readonly RunLevel[],
  key: Uint8Array,
): Maybe<Uint8Array | undefined> {
  if (mem?.kind === "del") return undefined;
  if (mem?.kind === "put") return new Uint8Array(mem.value!);
  return pointGetSst(levels, key);
}

/**
 * The newest entry for `key`, tombstone included. Each level asks at most
 * one run. A newer level must answer before an older one can, so this
 * stops at the first level that misses.
 */
export function latestSstEntry(
  levels: readonly RunLevel[],
  key: Uint8Array,
): Maybe<SstEntry | undefined> {
  for (const level of levels) {
    const hit = level.get(key);
    if (hit) return hit;
  }
  return undefined;
}

/** Newest run wins. A tombstone hides older puts. */
export function pointGetSst(
  levels: readonly RunLevel[],
  key: Uint8Array,
): Maybe<Uint8Array | undefined> {
  const hit = latestSstEntry(levels, key);
  if (hit instanceof Miss) return hit;
  return hit?.kind === "put" ? new Uint8Array(hit.value) : undefined;
}

/**
 * Runs whose key ranges never overlap, in key order: one level from L1
 * down, or a single L0 run. Routes by the key range each run's manifest
 * entry records, so routing reads no run bytes. A scan opens only the runs
 * it reaches, and a get asks only the run whose range holds the key.
 */
export class RunLevel {
  private readonly runs: SstReader[] = [];
  private readonly smallest: Uint8Array[] = [];
  private readonly largest: Uint8Array[] = [];

  constructor(readers: readonly SstReader[]) {
    for (const reader of readers) {
      const range = reader.range;
      if (!range) continue;
      this.runs.push(reader);
      this.smallest.push(range.smallest);
      this.largest.push(range.largest);
    }
  }

  /** The first run whose key in `keys` (`smallest` or `largest`) is at or after `key`. */
  private seek(keys: readonly Uint8Array[], key: Uint8Array): number {
    let lo = 0;
    let hi = this.runs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareBytes(keys[mid]!, key) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  get(key: Uint8Array): Maybe<SstEntry | undefined> {
    const r = this.seek(this.largest, key);
    if (r >= this.runs.length || compareBytes(this.smallest[r]!, key) > 0) return undefined;
    return this.runs[r]!.get(key);
  }

  cursor(bounds?: ScanBounds, reverse = false): LayerCursor {
    return this.concat(bounds, reverse, (run) => run.cursor(bounds, reverse));
  }

  /** The puts in `bounds` whose value holds every pattern, in key order or backward. */
  scanContains(patterns: readonly Uint8Array[], bounds?: ScanBounds, reverse = false): LayerCursor {
    return this.concat(bounds, reverse, (run) => run.scanContains(patterns, bounds, reverse));
  }

  /**
   * One cursor per run that `bounds` reaches, opened as the previous one ends.
   * Backward it starts at the last run below `endExclusive` and steps to the
   * run before.
   */
  private concat(bounds: ScanBounds | undefined, reverse: boolean, cursorOf: (run: SstReader) => LayerCursor): LayerCursor {
    const { runs, smallest, largest } = this;
    const start = bounds?.start;
    const end = bounds?.endExclusive;
    const step = reverse ? -1 : 1;
    let r = reverse ? (end ? this.seek(smallest, end) : runs.length) - 1 : start ? this.seek(largest, start) : 0;
    const open = reverse
      ? () => (r >= 0 && !(start && compareBytes(largest[r]!, start) < 0) ? cursorOf(runs[r]!) : undefined)
      : () => (r < runs.length && !(end && compareBytes(smallest[r]!, end) >= 0) ? cursorOf(runs[r]!) : undefined);
    let cur = open();
    return {
      peek() {
        while (cur) {
          const e = cur.peek();
          if (e) return e;
          r += step;
          cur = open();
        }
        return undefined;
      },
      next() {
        cur?.next();
      },
    };
  }
}

/**
 * The scan sources of a manifest's runs, newest first: each L0 run alone,
 * then one RunLevel per deeper level. A run with no level may overlap any
 * other, so it stands alone too.
 */
export function runLevels(
  paths: readonly string[],
  readers: readonly SstReader[],
): RunLevel[] {
  const out: RunLevel[] = [];
  let i = 0;
  while (i < readers.length) {
    const level = levelOf(paths[i]!);
    let j = i + 1;
    if (level !== undefined && level > 0) {
      while (j < readers.length && levelOf(paths[j]!) === level) j++;
    }
    out.push(new RunLevel(readers.slice(i, j)));
    i = j;
  }
  return out;
}

export function arrayCursor(rows: readonly MemRow[], reverse = false): LayerCursor {
  return entryCursor(
    rows.map((row) =>
      row.kind === "put" && row.value
        ? { key: row.key, kind: "put" as const, value: row.value }
        : { key: row.key, kind: "del" as const },
    ),
    reverse,
  );
}

/** The newest entry for one key and the source it came from. */
type Winner = { readonly entry: LayerEntry; readonly source: number };

/**
 * A heap merge of `cursors`, newest (smallest index) first, one key at a
 * time. `next` is sync until a cursor misses, and a miss leaves the merge
 * where it was. The sources a step moved are re-peeked together at the
 * start of the next step, the first step peeks every source, so a cold
 * merge gathers every source's miss into one parallel round of reads.
 */
class Merge {
  private readonly heap: MinHeap;
  private pending: number[];

  constructor(
    private readonly cursors: readonly LayerCursor[],
    reverse: boolean,
  ) {
    this.heap = new MinHeap(reverse ? heapGreater : heapLess);
    this.pending = cursors.map((_, i) => i);
  }

  next(): Maybe<Winner | undefined> {
    const { cursors, heap } = this;
    if (this.pending.length > 0) {
      let misses: Miss[] | undefined;
      let waiting: number[] | undefined;
      for (const source of this.pending) {
        const e = cursors[source]!.peek();
        if (e instanceof Miss) {
          (misses ??= []).push(e);
          (waiting ??= []).push(source);
        } else if (e) {
          heap.push({ key: e.key, source });
        }
      }
      this.pending = waiting ?? [];
      if (misses) return allMissed(misses);
    }
    const top = heap.pop();
    if (!top) return undefined;
    const entry = cursors[top.source]!.peek() as LayerEntry;
    cursors[top.source]!.next();
    this.pending.push(top.source);
    while (heap.length > 0 && compareBytes(heap.peek()!.key, entry.key) === 0) {
      const dup = heap.pop()!;
      cursors[dup.source]!.next();
      this.pending.push(dup.source);
    }
    return { entry, source: top.source };
  }
}

/**
 * `cursors[0]` is newest. Yields live puts only, up to `limit`. With `reverse`
 * every cursor runs backward and so does the merge.
 * Tombstones are not counted and not yielded. Awaits only on a miss.
 */
export async function* mergeCursors(
  cursors: readonly LayerCursor[],
  limit?: number,
  reverse = false,
): AsyncGenerator<Entry> {
  const merge = new Merge(cursors, reverse);
  let yielded = 0;
  for (;;) {
    if (limit !== undefined && yielded >= limit) return;
    let w = merge.next();
    while (w instanceof Miss) {
      await w.ready;
      w = merge.next();
    }
    if (!w) return;
    if (w.entry.kind === "del") continue;
    yield {
      key: new Uint8Array(w.entry.key),
      value: new Uint8Array(w.entry.value!),
    };
    yielded += 1;
  }
}

/**
 * The live puts in `bounds` whose current value holds every pattern, in key
 * order (descending with `reverse`), each key once, up to `limit`. `rows` is
 * the memtable slice for `bounds`, ascending and newer than every level.
 *
 * Each source filters on its own: memtable rows in JS, each level's runs in
 * wasm per block, so a block with no hit costs no JS per row. The newest
 * source that matches a key wins the merge. A newer source can still hold
 * that key with a value that does not match, or a tombstone, so the key is
 * kept only when no newer source holds it. That check asks only the newer
 * sources, mostly their Bloom filters, and leaves the page the match came
 * from untouched, so a scan does not count as reuse in the cache.
 */
export async function* scanMatching(
  rows: readonly MemRow[],
  levels: readonly RunLevel[],
  patterns: readonly Uint8Array[],
  bounds?: ScanBounds,
  limit?: number,
  reverse = false,
): AsyncGenerator<Entry> {
  const merge = new Merge(
    [filterCursor(arrayCursor(rows, reverse), patterns), ...levels.map((level) => level.scanContains(patterns, bounds, reverse))],
    reverse,
  );
  let yielded = 0;
  for (;;) {
    if (limit !== undefined && yielded >= limit) return;
    let w = merge.next();
    while (w instanceof Miss) {
      await w.ready;
      w = merge.next();
    }
    if (!w) return;
    const { entry, source } = w;
    if (source > 0) {
      const i = lowerBoundKeys(rows, entry.key);
      if (i < rows.length && compareBytes(rows[i]!.key, entry.key) === 0) continue;
      let newer = shadowed(levels, source - 1, entry.key);
      while (newer instanceof Miss) {
        await newer.ready;
        newer = shadowed(levels, source - 1, entry.key);
      }
      if (newer) continue;
    }
    yield { key: new Uint8Array(entry.key), value: new Uint8Array(entry.value!) };
    yielded += 1;
  }
}

/** Whether a level before `level` holds `key`. */
function shadowed(levels: readonly RunLevel[], level: number, key: Uint8Array): Maybe<boolean> {
  for (let l = 0; l < level; l++) {
    const hit = levels[l]!.get(key);
    if (hit instanceof Miss) return hit;
    if (hit) return true;
  }
  return false;
}

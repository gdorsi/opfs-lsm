import { compareBytes } from "../bytes.js";
import type { MemRow } from "./memtable.js";
import {
  allMissed,
  entryCursor,
  filterCursor,
  lowerBoundKeys,
  Miss,
  untilHit,
  type LayerCursor,
  type LayerEntry,
  type Maybe,
  type ScanBounds,
} from "./cursor.js";
import { markCursor, throughAt, type Marks, type Seq } from "./marks.js";
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
 * The rule every read applies to the newest version of a key, once the
 * memtable, the level order or the merge heap chose it: the version is gone
 * when it is a delete or a mark covers it. A covered newest version means
 * every older one is covered too, since they have the same key and smaller
 * seqs.
 */
function gone(v: { readonly kind: "put" | "del"; readonly seq: Seq }, through: Seq): boolean {
  return v.kind === "del" || v.seq <= through;
}

/**
 * `mem` is the row from the key-ordered mem store, or undefined on miss.
 * Levels are newest-first. Returned bytes are a fresh Uint8Array. A memtable
 * row needs no mark check: the memtable removed the rows its own marks
 * cover, and the installed marks stop below every row it holds.
 */
export function pointGet(
  mem: MemRow | undefined,
  levels: readonly RunLevel[],
  key: Uint8Array,
  marks: Marks,
): Maybe<Uint8Array | undefined> {
  if (mem?.kind === "del") return undefined;
  if (mem?.kind === "put") return new Uint8Array(mem.value!);
  const hit = latestSstEntry(levels, key);
  if (hit instanceof Miss) return hit;
  if (!hit || gone(hit, throughAt(marks, key))) return undefined;
  return hit.kind === "put" ? new Uint8Array(hit.value) : undefined;
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

type Ranged = SstReader & { readonly range: NonNullable<SstReader["range"]> };

/**
 * Runs whose key ranges never overlap, in key order: one level from L1
 * down, or a single L0 run. Routes by the key range each run's manifest
 * entry records, so routing reads no run bytes. A scan opens only the runs
 * it reaches, and a get asks only the run whose range holds the key.
 */
export class RunLevel {
  /** Runs with no keys have no range to route by, so they are dropped. */
  private readonly runs: Ranged[];

  constructor(readers: readonly SstReader[]) {
    this.runs = readers.filter((reader): reader is Ranged => reader.range !== undefined);
  }

  /** The first run whose `side` key is at or after `key`. */
  private seek(side: "smallest" | "largest", key: Uint8Array): number {
    const { runs } = this;
    let lo = 0;
    let hi = runs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareBytes(runs[mid]!.range[side], key) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  get(key: Uint8Array): Maybe<SstEntry | undefined> {
    const r = this.seek("largest", key);
    if (r >= this.runs.length || compareBytes(this.runs[r]!.range.smallest, key) > 0) return undefined;
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
  private concat(
    bounds: ScanBounds | undefined,
    reverse: boolean,
    cursorOf: (run: SstReader) => LayerCursor,
  ): LayerCursor {
    const { runs } = this;
    const start = bounds?.start;
    const end = bounds?.endExclusive;
    const step = reverse ? -1 : 1;
    let r = reverse ? (end ? this.seek("smallest", end) : runs.length) - 1 : start ? this.seek("largest", start) : 0;
    const open = reverse
      ? () => (r >= 0 && !(start && compareBytes(runs[r]!.range.largest, start) < 0) ? cursorOf(runs[r]!) : undefined)
      : () => (r < runs.length && !(end && compareBytes(runs[r]!.range.smallest, end) >= 0) ? cursorOf(runs[r]!) : undefined);
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
 * every cursor runs backward and so does the merge. Tombstones and covered
 * versions are not counted and not yielded. Awaits only on a miss.
 */
export async function* mergeCursors(
  cursors: readonly LayerCursor[],
  marks: Marks,
  limit?: number,
  reverse = false,
): AsyncGenerator<Entry> {
  const merge = new Merge(cursors, reverse);
  const through = markCursor(marks, reverse);
  let yielded = 0;
  for (;;) {
    if (limit !== undefined && yielded >= limit) return;
    let w = merge.next();
    if (w instanceof Miss) w = await untilHit(() => merge.next(), w);
    if (!w) return;
    if (gone(w.entry, through.at(w.entry.key))) continue;
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
  marks: Marks,
  bounds?: ScanBounds,
  limit?: number,
  reverse = false,
): AsyncGenerator<Entry> {
  const merge = new Merge(
    [filterCursor(entryCursor(rows, reverse), patterns), ...levels.map((level) => level.scanContains(patterns, bounds, reverse))],
    reverse,
  );
  const through = markCursor(marks, reverse);
  let yielded = 0;
  for (;;) {
    if (limit !== undefined && yielded >= limit) return;
    let w = merge.next();
    if (w instanceof Miss) w = await untilHit(() => merge.next(), w);
    if (!w) return;
    const { entry, source } = w;
    if (source > 0) {
      const i = lowerBoundKeys(rows, entry.key);
      if (i < rows.length && compareBytes(rows[i]!.key, entry.key) === 0) continue;
      let newer = shadowed(levels, source - 1, entry.key);
      if (newer instanceof Miss) newer = await untilHit(() => shadowed(levels, source - 1, entry.key), newer);
      if (newer) continue;
    }
    if (gone(entry, through.at(entry.key))) continue;
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

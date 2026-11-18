import { compareBytes } from "../bytes.js";
import { tallyRows, type MemRow, type MemRows } from "./memtable.js";
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
import type { Seq } from "../seq.js";
import { coversRun, NO_MARKS, throughAt, type Marks } from "./marks.js";
import { Sum, type SstEntry } from "./sst.js";
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

/** Every key read, or one Miss for all the bytes they lack. */
export function readKeys(
  rows: Pick<MemRows, "get">,
  keys: readonly Uint8Array[],
  levels: readonly RunLevel[],
  at: Marks,
): Maybe<(Uint8Array | undefined)[]> {
  const values: (Uint8Array | undefined)[] = [];
  let misses: Miss[] | undefined;
  for (const k of keys) {
    const v = pointGet(rows.get(k), levels, k, at);
    if (v instanceof Miss) (misses ??= []).push(v);
    else values.push(v);
  }
  return misses ? allMissed(misses) : values;
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

/** The cursor of a run a scan passes over. */
const NOTHING: LayerCursor = { peek: () => undefined, next() {} };

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

  /**
   * Adds to `sum` what the records with keys in `bounds` say (`Tally`). A
   * run wholly inside adds the totals its manifest entry records, so only
   * the run at each end of `bounds` is opened. On a Miss `sum` holds part
   * of the answer and must be dropped. With `exact` false it reads no block
   * and `plus - minus` is an upper bound (`SstReader.tally`).
   */
  tally(bounds: ScanBounds | undefined, sum: Sum, exact = true): Miss | undefined {
    const { runs } = this;
    const start = bounds?.start;
    const end = bounds?.endExclusive;
    let misses: Miss[] | undefined;
    for (let r = start ? this.seek("largest", start) : 0; r < runs.length; r++) {
      const run = runs[r]!;
      if (end && compareBytes(run.range.smallest, end) >= 0) break;
      const whole = (!start || compareBytes(start, run.range.smallest) <= 0) && (!end || compareBytes(run.range.largest, end) < 0);
      if (whole && run.totals) sum.add(run.totals);
      else {
        const miss = run.tally(bounds, sum, exact);
        if (miss) (misses ??= []).push(miss);
      }
    }
    return misses && allMissed(misses);
  }

  /** The runs that may hold a key of `bounds`, in key order. */
  overlapping(bounds: ScanBounds | undefined): readonly SstReader[] {
    const { runs } = this;
    const start = bounds?.start;
    const end = bounds?.endExclusive;
    const from = start ? this.seek("largest", start) : 0;
    let to = from;
    while (to < runs.length && !(end && compareBytes(runs[to]!.range.smallest, end) >= 0)) to++;
    return runs.slice(from, to);
  }

  /** `marks` is the read point the scan judges by. */
  cursor(bounds?: ScanBounds, reverse = false, marks: Marks = NO_MARKS): LayerCursor {
    return this.concat(bounds, reverse, marks, (run) => run.cursor(bounds, reverse));
  }

  /** The puts in `bounds` whose value holds every pattern, in key order or backward. */
  scanContains(patterns: readonly Uint8Array[], bounds?: ScanBounds, reverse = false, marks: Marks = NO_MARKS): LayerCursor {
    return this.concat(bounds, reverse, marks, (run) => run.scanContains(patterns, bounds, reverse));
  }

  /**
   * One cursor per run that `bounds` reaches, opened as the previous one ends.
   * Backward it starts at the last run below `endExclusive` and steps to the
   * run before. A run that one of `marks` covers within `bounds` is passed
   * over unread (`coversRun`).
   */
  private concat(
    bounds: ScanBounds | undefined,
    reverse: boolean,
    marks: Marks,
    cursorOf: (run: SstReader) => LayerCursor,
  ): LayerCursor {
    const { runs } = this;
    const start = bounds?.start;
    const end = bounds?.endExclusive;
    const step = reverse ? -1 : 1;
    let r = reverse ? (end ? this.seek("smallest", end) : runs.length) - 1 : start ? this.seek("largest", start) : 0;
    const cursorAt = (run: Ranged) => (coversRun(marks, run, bounds) ? NOTHING : cursorOf(run));
    const open = reverse
      ? () => (r >= 0 && !(start && compareBytes(runs[r]!.range.largest, start) < 0) ? cursorAt(runs[r]!) : undefined)
      : () => (r < runs.length && !(end && compareBytes(runs[r]!.range.smallest, end) >= 0) ? cursorAt(runs[r]!) : undefined);
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
 * A scan's next live put, or undefined at its end. Sync until a cursor
 * misses; after a Miss, call it again once the Miss is ready and it goes on
 * from the same place.
 */
export type ScanStep = () => Maybe<LayerEntry | undefined>;

/**
 * The live puts of `cursors`, `cursors[0]` newest. With `reverse` every
 * cursor runs backward and so does the merge. Tombstones and covered
 * versions are skipped.
 */
export function liveStep(cursors: readonly LayerCursor[], marks: Marks, reverse = false): ScanStep {
  const merge = new Merge(cursors, reverse);
  return () => {
    for (;;) {
      const w = merge.next();
      if (w instanceof Miss || !w) return w;
      if (!gone(w.entry, throughAt(marks, w.entry.key))) return w.entry;
    }
  };
}

/**
 * The live puts in `bounds` whose current value holds every pattern, in key
 * order (descending with `reverse`), each key once. `rows` is the memtable
 * slice for `bounds`, ascending and newer than every level.
 *
 * Each source filters on its own: memtable rows in JS, each level's runs in
 * wasm per block, so a block with no hit costs no JS per row. The newest
 * source that matches a key wins the merge. A newer source can still hold
 * that key with a value that does not match, or a tombstone, so the key is
 * kept only when no newer source holds it. That check asks only the newer
 * sources, mostly their Bloom filters, and leaves the page the match came
 * from untouched, so a scan does not count as reuse in the cache.
 */
export function matchingStep(
  rows: readonly MemRow[],
  levels: readonly RunLevel[],
  patterns: readonly Uint8Array[],
  marks: Marks,
  bounds?: ScanBounds,
  reverse = false,
): ScanStep {
  const merge = new Merge(
    [filterCursor(entryCursor(rows, reverse), patterns), ...levels.map((level) => level.scanContains(patterns, bounds, reverse, marks))],
    reverse,
  );
  /** A match whose check against the newer sources missed, checked again on the next call. */
  let held: Winner | undefined;
  return () => {
    for (;;) {
      const w = held ?? merge.next();
      if (w instanceof Miss || !w) return w;
      held = undefined;
      const { entry, source } = w;
      if (source > 0) {
        const i = lowerBoundKeys(rows, entry.key);
        if (i < rows.length && compareBytes(rows[i]!.key, entry.key) === 0) continue;
        const newer = shadowed(levels, source - 1, entry.key);
        if (newer instanceof Miss) {
          held = w;
          return newer;
        }
        if (newer) continue;
      }
      if (!gone(entry, throughAt(marks, entry.key))) return entry;
    }
  };
}

/** Whether the range of `mark` holds a key of `bounds`. */
function meets(mark: Marks[number], bounds: ScanBounds | undefined): boolean {
  const start = bounds?.start;
  const end = bounds?.endExclusive;
  return (!end || compareBytes(mark.start, end) < 0) && (!mark.endExclusive || !start || compareBytes(start, mark.endExclusive) < 0);
}

/**
 * How many live keys `bounds` holds, added up from what the memtable rows
 * and the runs say they did to that number (`Tally`), with no merge: each
 * key's records, over the sources that hold its versions once each, say
 * plus once more than minus when it is live and as often when it is not.
 *
 * Undefined when the sum would be wrong, and the caller scans: a record in
 * `bounds` does not say what held before it, or a mark meets `bounds`,
 * since a version a mark covers is still counted by the run that holds it.
 */
export function liveCount(
  rows: readonly MemRow[],
  levels: readonly RunLevel[],
  marks: Marks,
  bounds: ScanBounds | undefined,
): Maybe<number | undefined> {
  if (marks.some((mark) => meets(mark, bounds))) return undefined;
  const sum = new Sum();
  tallyRows(rows, sum);
  let misses: Miss[] | undefined;
  for (const level of levels) {
    if (sum.unknown > 0) return undefined;
    const miss = level.tally(bounds, sum);
    if (miss) (misses ??= []).push(miss);
  }
  if (misses) return allMissed(misses);
  return sum.unknown > 0 || sum.plus < sum.minus ? undefined : sum.plus - sum.minus;
}

/** An offset below this is walked: finding where to start costs more than the walk. */
const SEEK_FROM = 256;

/** Where a scan may start (`at`: its new start, or its new end going back) after skipping `skipped` entries of its offset. */
export type Seek = { readonly at: Uint8Array; readonly skipped: number };

/**
 * The first of `count` candidates for which `fits` holds when `fromEnd`, or
 * the last one otherwise. `fits` must hold for a run of candidates at that
 * end. Outside 0 to `count - 1` when it holds for none.
 */
function edgeOf(count: number, fromEnd: boolean, fits: (i: number) => Maybe<boolean>): Maybe<number> {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const ok = fits(mid);
    if (ok instanceof Miss) return ok;
    if (ok === fromEnd) hi = mid;
    else lo = mid + 1;
  }
  return fromEnd ? lo : lo - 1;
}

/**
 * Where a scan of `bounds` that skips `offset` entries can start instead,
 * so that it walks a block or two and not the entries it skips. Undefined
 * when the scan should walk: the offset is small, or the entries to skip
 * cannot be counted (`liveCount`).
 *
 * Each step moves the start as far as one level can take it (`seekStep`),
 * then the next step goes on from there with what is left of the offset,
 * until no level has a key to offer. A range spread over several levels
 * takes a step per level.
 */
export function seekOffset(
  rows: readonly MemRow[],
  levels: readonly RunLevel[],
  marks: Marks,
  bounds: ScanBounds | undefined,
  offset: number,
  reverse: boolean,
): Maybe<Seek | undefined> {
  if (marks.some((mark) => meets(mark, bounds))) return undefined;
  let found: Seek | undefined;
  for (let steps = 0; steps < 2 * levels.length + 2 && offset - (found?.skipped ?? 0) >= SEEK_FROM; steps++) {
    const step = seekStep(rows, levels, marks, bounds, offset - (found?.skipped ?? 0), reverse);
    if (step instanceof Miss) return step;
    if (!step) break;
    found = { at: step.at, skipped: (found?.skipped ?? 0) + step.skipped };
    const cut = lowerBoundKeys(rows, step.at);
    rows = reverse ? rows.slice(0, cut) : rows.slice(cut);
    bounds = reverse ? { ...bounds, endExclusive: step.at } : { ...bounds, start: step.at };
  }
  return found;
}

/**
 * One step of `seekOffset`. The level that holds most of `bounds` gives the
 * keys to start at: where its runs begin, then where the blocks of one run
 * begin. For such a key, the indexes alone bound how many live keys the
 * skipped part holds, a block's worth of slack per level and end. It takes
 * the furthest key whose bound fits in `offset` and counts the skipped part
 * exactly, which reads the blocks the scan is about to enter.
 */
function seekStep(
  rows: readonly MemRow[],
  levels: readonly RunLevel[],
  marks: Marks,
  bounds: ScanBounds | undefined,
  offset: number,
  reverse: boolean,
): Maybe<Seek | undefined> {
  const lo = bounds?.start;
  const hi = bounds?.endExclusive;
  // What the first i rows add up to, and how many of them do not say.
  const net = new Int32Array(rows.length + 1);
  const unsaid = new Int32Array(rows.length + 1);
  rows.forEach((row, i) => {
    const said = row.was === undefined ? 0 : row.kind === "put" ? (row.was === "absent" ? 1 : 0) : row.was === "present" ? -1 : 0;
    net[i + 1] = net[i]! + said;
    unsaid[i + 1] = unsaid[i]! + (row.was === undefined ? 1 : 0);
  });
  const skippedBy = (at: Uint8Array): ScanBounds => (reverse ? { start: at, ...(hi ? { endExclusive: hi } : {}) } : { ...(lo ? { start: lo } : {}), endExclusive: at });
  /** Whether a scan that starts at `at` skips at most `offset` live keys, judged with no block read. */
  const fits = (at: Uint8Array): Maybe<boolean> => {
    const cut = lowerBoundKeys(rows, at);
    const [i, j] = reverse ? [cut, rows.length] : [0, cut];
    if (unsaid[j]! > unsaid[i]!) return false;
    const sum = new Sum();
    let misses: Miss[] | undefined;
    for (const level of levels) {
      const miss = level.tally(skippedBy(at), sum, false);
      if (miss) (misses ??= []).push(miss);
    }
    if (misses) return allMissed(misses);
    return sum.unknown === 0 && net[j]! - net[i]! + sum.plus - sum.minus <= offset;
  };
  // Strictly inside: a scan that starts at its own start has skipped nothing.
  const inside = (key: Uint8Array) => (!lo || compareBytes(key, lo) > 0) && (!hi || compareBytes(key, hi) < 0);

  // The level that has the most to skip in the bounds, by what its indexes say.
  let most = 0;
  let runs: readonly SstReader[] = [];
  let misses: Miss[] | undefined;
  for (const level of levels) {
    const sum = new Sum();
    const miss = level.tally(bounds, sum, false);
    if (miss) (misses ??= []).push(miss);
    else if (sum.plus - sum.minus > most) [most, runs] = [sum.plus - sum.minus, level.overlapping(bounds)];
  }
  if (misses) return allMissed(misses);

  // Where the runs begin: the last one a forward scan may start at, the first one a backward scan may end at.
  const starts = runs.map((run) => run.range!.smallest).filter(inside);
  const edge = edgeOf(starts.length, reverse, (i) => fits(starts[i]!));
  if (edge instanceof Miss) return edge;
  let at = starts[edge];
  // The run that holds the rest of the way: the one that begins at `at`, or going back the one before it.
  const next = at === undefined ? (reverse ? runs.length - 1 : 0) : runs.findIndex((run) => run.range!.smallest === at) - (reverse ? 1 : 0);
  const run: SstReader | undefined = runs[next];
  if (run) {
    const splits = run.splits();
    if (splits instanceof Miss) return splits;
    const block = edgeOf(splits.count, reverse, (i) => {
      const key = splits.key(i);
      // Outside the bounds a key cuts nothing: it counts as fitting on the side the scan starts from.
      if (!inside(key)) return (lo !== undefined && compareBytes(key, lo) <= 0) !== reverse;
      return fits(key);
    });
    if (block instanceof Miss) return block;
    const key = block >= 0 && block < splits.count ? splits.key(block) : undefined;
    if (key && inside(key)) at = key.slice();
  }
  if (!at) return undefined;
  const cut = lowerBoundKeys(rows, at);
  const skipped = liveCount(reverse ? rows.slice(cut) : rows.slice(0, cut), levels, marks, skippedBy(at));
  if (skipped instanceof Miss) return skipped;
  return skipped === undefined || skipped > offset ? undefined : { at, skipped };
}

/** Moves `step` past `offset` entries. False when it ended first. Awaits only on a miss. */
async function skip(step: ScanStep, offset: number): Promise<boolean> {
  for (let n = 0; n < offset; n++) {
    let e = step();
    if (e instanceof Miss) e = await untilHit(step, e);
    if (!e) return false;
  }
  return true;
}

/** Copies of the entries of `step` after the first `offset`, up to `limit`. Awaits only on a miss. */
export async function* entriesOf(step: ScanStep, limit?: number, offset = 0): AsyncGenerator<Entry> {
  if (offset > 0 && !(await skip(step, offset))) return;
  for (let n = 0; limit === undefined || n < limit; n++) {
    let e = step();
    if (e instanceof Miss) e = await untilHit(step, e);
    if (!e) return;
    yield { key: new Uint8Array(e.key), value: new Uint8Array(e.value!) };
  }
}

/** How many entries `step` has after the first `offset`, up to `limit`, read without copying one. Awaits only on a miss. */
export async function countOf(step: ScanStep, limit?: number, offset = 0): Promise<number> {
  if (offset > 0 && !(await skip(step, offset))) return 0;
  let n = 0;
  while (limit === undefined || n < limit) {
    let e = step();
    if (e instanceof Miss) e = await untilHit(step, e);
    if (!e) break;
    n++;
  }
  return n;
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

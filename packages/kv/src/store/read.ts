import { compareBytes } from "../bytes.js";
import type { MemRow, MemRows } from "./memtable.js";
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
 * What the memtable `rows`, already cut to `bounds`, and the runs say they
 * did to the number of live keys of `bounds` (`Tally`). Inexact, it reads no
 * block, and `plus` less `minus` is an upper bound of the live keys.
 */
function tallyOf(rows: readonly MemRow[], levels: readonly RunLevel[], bounds: ScanBounds | undefined, exact: boolean): Maybe<Sum> {
  const sum = new Sum();
  for (const row of rows) sum.count(row.kind === "put", row.was);
  let misses: Miss[] | undefined;
  for (const level of levels) {
    // A record that does not say settles it: no older level can make the sum a count, so none is read.
    if (sum.unknown > 0) return sum;
    const miss = level.tally(bounds, sum, exact);
    if (miss) (misses ??= []).push(miss);
  }
  return misses ? allMissed(misses) : sum;
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
  const sum = tallyOf(rows, levels, bounds, true);
  return sum instanceof Miss ? sum : sum.live;
}

/** An offset below this is walked: finding where to start costs more than the walk. */
const SEEK_FROM = 256;

/** A scan: the memtable rows and the bounds left to it, and how many entries it has still to skip. */
export type ScanStart = { readonly rows: readonly MemRow[]; readonly bounds: ScanBounds | undefined; readonly offset: number };

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

/** `scan` cut at `at`: the part before it going forward, after it going back (`skipped`), or the rest. */
function cutAt(scan: ScanStart, at: Uint8Array, reverse: boolean, skipped: boolean): ScanStart {
  const { rows, bounds, offset } = scan;
  const cut = lowerBoundKeys(rows, at);
  return reverse === skipped
    ? { rows: rows.slice(cut), bounds: { ...bounds, start: at }, offset }
    : { rows: rows.slice(0, cut), bounds: { ...bounds, endExclusive: at }, offset };
}

/**
 * Where a scan that skips `offset` entries can start instead, so that it
 * walks a block or two and not the entries it skips. The scan itself when
 * it should walk: the offset is small, or the entries to skip cannot be
 * counted (`liveCount`).
 *
 * Each step moves the start as far as one level can take it (`seekStep`),
 * then the next step goes on from there with what is left of the offset,
 * until no level has a key to offer. A range spread over several levels
 * takes a step per level.
 */
export function seekOffset(scan: ScanStart, levels: readonly RunLevel[], marks: Marks, reverse: boolean): Maybe<ScanStart> {
  if (marks.some((mark) => meets(mark, scan.bounds))) return scan;
  for (let steps = 0; steps < 2 * levels.length + 2 && scan.offset >= SEEK_FROM; steps++) {
    const next = seekStep(scan, levels, marks, reverse);
    if (next instanceof Miss) return next;
    if (!next) break;
    scan = next;
  }
  return scan;
}

/**
 * One step of `seekOffset`. The level that holds most of the bounds gives
 * the keys to start at: where its runs begin, then where the blocks of one
 * run begin. For such a key, the indexes alone bound how many live keys the
 * skipped part holds, a block's worth of slack per level and end. It takes
 * the furthest key whose bound fits in the offset and counts the skipped
 * part exactly, which reads the blocks the scan is about to enter.
 */
function seekStep(scan: ScanStart, levels: readonly RunLevel[], marks: Marks, reverse: boolean): Maybe<ScanStart | undefined> {
  const { bounds, offset } = scan;
  const lo = bounds?.start;
  const hi = bounds?.endExclusive;
  /** Whether the indexes alone show that a scan from `at` skips at most `offset` live keys. */
  const fits = (at: Uint8Array): Maybe<boolean> => {
    const skipped = cutAt(scan, at, reverse, true);
    const sum = tallyOf(skipped.rows, levels, skipped.bounds, false);
    if (sum instanceof Miss) return sum;
    const live = sum.live;
    return live !== undefined && live <= offset;
  };
  const inside = (key: Uint8Array) => (!lo || compareBytes(key, lo) > 0) && (!hi || compareBytes(key, hi) < 0);

  let most = 0;
  let runs: readonly SstReader[] = [];
  let misses: Miss[] | undefined;
  for (const level of levels) {
    const sum = tallyOf([], [level], bounds, false);
    if (sum instanceof Miss) (misses ??= []).push(sum);
    else if (sum.plus - sum.minus > most) [most, runs] = [sum.plus - sum.minus, level.overlapping(bounds)];
  }
  if (misses) return allMissed(misses);

  /** `edgeOf` over `count` keys in key order. A key outside the bounds fits when a scan from it skips nothing. */
  const edge = (count: number, keyAt: (i: number) => Uint8Array) =>
    edgeOf(count, reverse, (i) => {
      const key = keyAt(i);
      return inside(key) ? fits(key) : (lo !== undefined && compareBytes(key, lo) <= 0) !== reverse;
    });
  const r = edge(runs.length, (i) => runs[i]!.range!.smallest);
  if (r instanceof Miss) return r;
  let at = runs[r]?.range!.smallest;
  // Going forward the start is inside run `r`, going back inside the run before it.
  const run: SstReader | undefined = runs[reverse ? r - 1 : r];
  if (run) {
    const splits = run.splits();
    if (splits instanceof Miss) return splits;
    const block = edge(splits.count, splits.key);
    if (block instanceof Miss) return block;
    if (block >= 0 && block < splits.count) at = splits.key(block).slice();
  }
  if (!at || !inside(at)) return undefined;
  const skipped = cutAt(scan, at, reverse, true);
  const live = liveCount(skipped.rows, levels, marks, skipped.bounds);
  if (live instanceof Miss) return live;
  return live === undefined || live > offset ? undefined : { ...cutAt(scan, at, reverse, false), offset: offset - live };
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

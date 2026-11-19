import { compareBytes, compareFrom, sharedPrefix } from "../bytes.js";
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
import type { SstEntry } from "./sst.js";
import type { SstReader } from "./sst-reader.js";
import { levelOf } from "./levels.js";

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
 * Levels are newest-first. Returned bytes are a fresh Uint8Array: a copy of
 * the memtable row's value, or the one copy a run's get made. A memtable
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
  return hit.kind === "put" ? hit.value : undefined;
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

/**
 * A merge of `cursors`, newest (smallest index) first, one key at a time.
 * The sources that wait on an entry sit in a binary heap of source numbers,
 * ordered by that entry's key and then by the newer source. `next` is sync
 * until a cursor misses, and a miss leaves the merge where it was. The
 * sources a step moved are peeked together at the start of the next step,
 * the first step peeks every source, so a cold merge gathers every source's
 * miss into one parallel round of reads.
 */
class Merge {
  /** The source of the entry `next` returned last. */
  source = -1;
  /** `heads[s]` is the entry source `s` waits on while it is in `heap`. */
  private readonly heads: LayerEntry[];
  private readonly heap: number[];
  private size = 0;
  /** The sources the last step moved, which the next step peeks. */
  private readonly moved: number[];
  private movedCount: number;
  /** -1 when the merge runs backward, so the largest key sorts first. */
  private readonly sign: number;

  /**
   * `skip` is how many leading bytes every key of every cursor shares, so
   * no compare reads them: the keys of one index query repeat its prefix.
   */
  constructor(
    private readonly cursors: readonly LayerCursor[],
    reverse: boolean,
    private readonly skip: number,
  ) {
    this.heads = new Array<LayerEntry>(cursors.length);
    this.heap = cursors.map(() => 0);
    this.moved = cursors.map((_, i) => i);
    this.movedCount = cursors.length;
    this.sign = reverse ? -1 : 1;
  }

  next(): Maybe<LayerEntry | undefined> {
    const { cursors, heads, heap, moved } = this;
    let top = -1;
    if (this.movedCount === 1) {
      // Only the last winner moved, which is the usual step. While its next
      // entry still sorts before every waiting source it never enters the
      // heap, so a source that wins again costs one comparison.
      const s = moved[0]!;
      const e = cursors[s]!.peek();
      if (e instanceof Miss) return e;
      this.movedCount = 0;
      if (e) {
        heads[s] = e;
        const c = this.size === 0 ? -1 : this.sign * compareFrom(e.key, heads[heap[0]!]!.key, this.skip);
        if (c < 0) {
          cursors[s]!.next();
          this.movedCount = 1;
          this.source = s;
          return e;
        }
        if (c === 0 && s < heap[0]!) top = s;
        else {
          top = heap[0]!;
          this.sink(s);
        }
      }
    } else if (this.movedCount > 1) {
      let misses: Miss[] | undefined;
      let waiting = 0;
      for (let i = 0; i < this.movedCount; i++) {
        const s = moved[i]!;
        const e = cursors[s]!.peek();
        if (e instanceof Miss) {
          (misses ??= []).push(e);
          moved[waiting++] = s;
        } else if (e) {
          heads[s] = e;
          this.push(s);
        }
      }
      this.movedCount = waiting;
      if (misses) return allMissed(misses);
    }
    if (top < 0) {
      if (this.size === 0) return undefined;
      top = this.pop();
    }
    const entry = heads[top]!;
    cursors[top]!.next();
    moved[this.movedCount++] = top;
    // Every older source that holds the same key steps past it.
    while (this.size > 0 && compareFrom(heads[heap[0]!]!.key, entry.key, this.skip) === 0) {
      const dup = this.pop();
      cursors[dup]!.next();
      moved[this.movedCount++] = dup;
    }
    this.source = top;
    return entry;
  }

  /** Whether source `a` sorts before source `b`: by key, then the newer source. */
  private before(a: number, b: number): boolean {
    const c = this.sign * compareFrom(this.heads[a]!.key, this.heads[b]!.key, this.skip);
    return c !== 0 ? c < 0 : a < b;
  }

  private push(s: number): void {
    const { heap } = this;
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.before(s, heap[parent]!)) break;
      heap[i] = heap[parent]!;
      i = parent;
    }
    heap[i] = s;
  }

  private pop(): number {
    const { heap } = this;
    const first = heap[0]!;
    const last = heap[--this.size]!;
    if (this.size > 0) this.sink(last);
    return first;
  }

  /** Puts `s` in place of the first source and moves it down to where it sorts. */
  private sink(s: number): void {
    const { heap, size } = this;
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= size) break;
      if (child + 1 < size && this.before(heap[child + 1]!, heap[child]!)) child++;
      if (!this.before(heap[child]!, s)) break;
      heap[i] = heap[child]!;
      i = child;
    }
    heap[i] = s;
  }
}

/** How many leading bytes every key inside `bounds` shares: a key between two keys starts with what both start with. */
function boundsPrefix(bounds: ScanBounds | undefined): number {
  return bounds?.start && bounds.endExclusive ? sharedPrefix(bounds.start, bounds.endExclusive) : 0;
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
export function liveStep(cursors: readonly LayerCursor[], marks: Marks, reverse = false, bounds?: ScanBounds): ScanStep {
  const merge = new Merge(cursors, reverse, boundsPrefix(bounds));
  return () => {
    for (;;) {
      const e = merge.next();
      if (e instanceof Miss || !e) return e;
      if (!gone(e, throughAt(marks, e.key))) return e;
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
    boundsPrefix(bounds),
  );
  /** A match whose check against the newer sources missed, checked again on the next call. */
  let held: LayerEntry | undefined;
  return () => {
    for (;;) {
      const entry = held ?? merge.next();
      if (entry instanceof Miss || !entry) return entry;
      held = undefined;
      // The merge moves only in `next`, so a held match still has its source.
      const { source } = merge;
      if (source > 0) {
        const i = lowerBoundKeys(rows, entry.key);
        if (i < rows.length && compareBytes(rows[i]!.key, entry.key) === 0) continue;
        const newer = shadowed(levels, source - 1, entry.key);
        if (newer instanceof Miss) {
          held = entry;
          return newer;
        }
        if (newer) continue;
      }
      if (!gone(entry, throughAt(marks, entry.key))) return entry;
    }
  };
}

/** How many entries `step` has, read without copying one. Awaits only on a miss. */
export async function countOf(step: ScanStep): Promise<number> {
  let n = 0;
  for (;;) {
    let e = step();
    if (e instanceof Miss) e = await untilHit(step, e);
    if (!e) return n;
    n++;
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

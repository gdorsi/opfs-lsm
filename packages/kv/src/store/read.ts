import { compareBytes, sharedPrefix } from "../bytes.js";
import type { MemRow } from "./memtable.js";
import {
  allMissed,
  compareEntries,
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
import { RecordWalker } from "./sst.js";
import type { SstReader } from "./sst-reader.js";
import { levelOf } from "./levels.js";

/**
 * The live put of `key`, where its bytes are, or undefined: a memtable row,
 * or the walker a run's get left on the record. `mem` is the row from the
 * key-ordered mem store, or undefined on miss. Levels are newest-first. A
 * memtable row needs no mark check: the memtable removed the rows its own
 * marks cover, and the installed marks stop below every row it holds.
 */
function livePut(
  mem: MemRow | undefined,
  levels: readonly RunLevel[],
  key: Uint8Array,
  marks: Marks,
): Maybe<MemRow | RecordWalker | undefined> {
  if (mem) return mem.kind === "put" ? mem : undefined;
  const hit = latestSstEntry(levels, key);
  if (hit === undefined || hit instanceof Miss) return hit;
  return isLive(hit, throughAt(marks, key)) ? hit : undefined;
}

/**
 * The rule every read applies to the newest version of a key, once the
 * memtable, the level order or the merge chose it: the version is live when
 * it is a put no mark covers. A covered newest version means every older one
 * is covered too, since they have the same key and smaller seqs. A scan
 * applies it to its entries in place.
 */
function isLive(at: RecordWalker, through: Seq): boolean {
  return at.isPut() && at.seq() > through;
}

/** A found put's value: a copy that owns its buffer, or what `decode` makes of the bytes where they are stored. */
function valueOfPut<T>(put: MemRow | RecordWalker, decode: ((value: Uint8Array) => T) | undefined): T {
  if (put instanceof RecordWalker) return runValue(put, decode);
  return decode ? decode(put.value!) : (new Uint8Array(put.value!) as T);
}

function runValue<T>(at: RecordWalker, decode: ((value: Uint8Array) => T) | undefined): T {
  return decode ? decode(at.valueInPlace()) : (at.value() as T);
}

/** The value of `key` as a fresh Uint8Array, or undefined. See `livePut`. */
export function pointGet(
  mem: MemRow | undefined,
  levels: readonly RunLevel[],
  key: Uint8Array,
  marks: Marks,
): Maybe<Uint8Array | undefined> {
  const put = livePut(mem, levels, key, marks);
  return put === undefined || put instanceof Miss ? put : valueOfPut<Uint8Array>(put, undefined);
}

/**
 * A read of every key, to run again after each Miss: it returns every value,
 * or one Miss for all the bytes they lack. `mems[i]` is the memtable row of
 * `keys[i]`. A key one run found is not looked up again, so a retry costs
 * the keys that missed, and every run must be given the same levels. A value
 * is a copy, or what `decode` makes of the stored bytes: it runs once every
 * key is found, so a retry decodes nothing twice, and it must neither change
 * the bytes nor keep them.
 */
export function keysReader<T = Uint8Array>(
  mems: readonly (MemRow | undefined)[],
  keys: readonly Uint8Array[],
  at: Marks,
  decode?: (value: Uint8Array) => T,
): (levels: readonly RunLevel[]) => Maybe<(T | undefined)[]> {
  const found = new Array<MemRow | RecordWalker | undefined>(keys.length);
  let missed: number[] | undefined;
  return (levels) => {
    const misses: Miss[] = [];
    const still: number[] = [];
    const count = missed ? missed.length : keys.length;
    for (let j = 0; j < count; j++) {
      const i = missed ? missed[j]! : j;
      const put = livePut(mems[i], levels, keys[i]!, at);
      if (put instanceof Miss) {
        misses.push(put);
        still.push(i);
      } else found[i] = put;
    }
    missed = still;
    if (misses.length) return allMissed(misses);
    // Pushed, not assigned by index: a key with no value must be an element, not a hole.
    const values: (T | undefined)[] = [];
    for (let i = 0; i < keys.length; i++) {
      const put = found[i];
      values.push(put === undefined ? undefined : valueOfPut(put, decode));
    }
    return values;
  };
}

/**
 * The newest entry for `key`, tombstone included. Each level asks at most
 * one run. A newer level must answer before an older one can, so this
 * stops at the first level that misses.
 */
export function latestSstEntry(
  levels: readonly RunLevel[],
  key: Uint8Array,
): Maybe<RecordWalker | undefined> {
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

  get(key: Uint8Array): Maybe<RecordWalker | undefined> {
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
 * The sources that wait on an entry sit in a list of source numbers, sorted
 * by that entry's key and then by the newer source. A source enters the
 * list from its front, where the source that just won usually belongs: a
 * merge has few sources, and the walk stops at the first one it sorts
 * before. `next` is sync until a cursor misses, and a miss leaves the merge
 * where it was. The sources a step moved are peeked together at the start of
 * the next step, the first step peeks every source, so a cold merge gathers
 * every source's miss into one parallel round of reads.
 */
class Merge {
  /** The source of the entry `next` returned last. */
  source = -1;
  /** `heads[s]` is the entry source `s` waits on while it is in `order`. */
  private readonly heads: LayerEntry[];
  /** The waiting sources, the one with the next key last: `order[size - 1]`. */
  private readonly order: number[];
  private size = 0;
  /**
   * `tied[s]` is a newer waiting source whose head holds the same key as the
   * head of `s`, or -1 when no newer one does. `enter` sets it for every
   * source it puts behind one with its key, and sources with one key leave
   * together, so two keys are compared once and a source left first in
   * `order` with a tie holds the key of the entry just taken.
   */
  private readonly tied: number[];
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
    this.order = cursors.map(() => 0);
    this.tied = cursors.map(() => -1);
    this.moved = cursors.map((_, i) => i);
    this.movedCount = cursors.length;
    this.sign = reverse ? -1 : 1;
  }

  next(): Maybe<LayerEntry | undefined> {
    const { cursors, heads, order, moved, tied } = this;
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
        this.enter(s, e);
      }
    }
    this.movedCount = waiting;
    if (misses) return allMissed(misses);
    if (this.size === 0) return undefined;
    const top = order[--this.size]!;
    cursors[top]!.next();
    moved[this.movedCount++] = top;
    // Every older source that holds the same key steps past it.
    while (this.size > 0 && tied[order[this.size - 1]!] !== -1) {
      const dup = order[--this.size]!;
      cursors[dup]!.next();
      moved[this.movedCount++] = dup;
    }
    this.source = top;
    return heads[top]!;
  }

  /** Puts source `s`, which waits on `e`, where it sorts. */
  private enter(s: number, e: LayerEntry): void {
    const { heads, order, tied } = this;
    tied[s] = -1;
    let i = this.size++;
    while (i > 0) {
      const t = order[i - 1]!;
      const c = this.sign * compareEntries(e, heads[t]!, this.skip);
      if (c < 0) break;
      if (c === 0 && s < t) {
        tied[t] = s;
        break;
      }
      order[i--] = t;
      if (c === 0) {
        tied[s] = t;
        // The sources behind `t` with a tie hold this key too: only their age places `s` among them.
        while (i > 0 && tied[order[i - 1]!] !== -1 && order[i - 1]! < s) {
          order[i] = order[i - 1]!;
          i--;
        }
        break;
      }
    }
    order[i] = s;
  }
}

/** How many leading bytes every key inside `bounds` shares: a key between two keys starts with what both start with. */
function boundsPrefix(bounds: ScanBounds | undefined): number {
  return bounds?.start && bounds.endExclusive ? sharedPrefix(bounds.start, bounds.endExclusive) : 0;
}

/** The marks that can hold a key inside `bounds`. A scan judges by these alone, mostly none. */
function marksIn(marks: Marks, bounds: ScanBounds | undefined): Marks {
  const start = bounds?.start;
  const end = bounds?.endExclusive;
  return marks.filter(
    (m) => (!end || compareBytes(m.start, end) < 0) && (!start || !m.endExclusive || compareBytes(start, m.endExclusive) < 0),
  );
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
  const inside = marksIn(marks, bounds);
  return () => {
    for (;;) {
      const e = merge.next();
      if (e instanceof Miss || !e) return e;
      if (e.kind === "put" && (inside.length === 0 || e.seq > throughAt(inside, e.block ? e : e.key))) return e;
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
  const inside = marksIn(marks, bounds);
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
      if (entry.kind === "put" && entry.seq > throughAt(inside, entry.block ? entry : entry.key)) return entry;
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

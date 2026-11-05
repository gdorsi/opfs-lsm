import { compareBytes } from "../bytes.js";
import type { MemRow } from "./memtable.js";
import {
  entryCursor,
  type LayerCursor,
  type ScanBounds,
} from "./cursor.js";
import type { SstEntry, SstReader } from "./sst.js";
import type { Entry } from "../db.js";
import { levelOf } from "./levels.js";

type HeapItem = { key: Uint8Array; source: number };

function heapLess(a: HeapItem, b: HeapItem): boolean {
  const c = compareBytes(a.key, b.key);
  if (c !== 0) return c < 0;
  return a.source < b.source;
}

/** Binary min-heap. Order is key, then newer source (smaller index). */
class MinHeap {
  private readonly items: HeapItem[] = [];

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
      if (!heapLess(a[i]!, a[p]!)) break;
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
      if (l < a.length && heapLess(a[l]!, a[m]!)) m = l;
      if (r < a.length && heapLess(a[r]!, a[m]!)) m = r;
      if (m === i) break;
      const tmp = a[m]!;
      a[m] = a[i]!;
      a[i] = tmp;
      i = m;
    }
    return top;
  }
}

function pushPeek(
  heap: MinHeap,
  cursors: readonly LayerCursor[],
  source: number,
): void {
  const e = cursors[source]!.peek();
  if (e) heap.push({ key: e.key, source });
}

/**
 * `mem` is the row from the key-ordered mem store, or undefined on miss.
 * Readers are newest-first. Returned bytes are a fresh Uint8Array.
 */
export function pointGet(
  mem: MemRow | undefined,
  readers: readonly SstReader[],
  key: Uint8Array,
): Uint8Array | undefined {
  if (mem?.kind === "del") return undefined;
  if (mem?.kind === "put") return new Uint8Array(mem.value!);
  return pointGetSst(readers, key);
}

/** The newest entry for `key`, tombstone included. Bloom rejects skip the block. */
export function latestSstEntry(
  readers: readonly SstReader[],
  key: Uint8Array,
): SstEntry | undefined {
  for (const reader of readers) {
    const hit = reader.get(key);
    if (hit) return hit;
  }
  return undefined;
}

/** Newest run wins. A tombstone hides older puts. */
export function pointGetSst(
  readers: readonly SstReader[],
  key: Uint8Array,
): Uint8Array | undefined {
  const hit = latestSstEntry(readers, key);
  return hit?.kind === "put" ? new Uint8Array(hit.value) : undefined;
}

/**
 * Runs whose key ranges never overlap, in key order: one level from L1
 * down, or a single L0 run. A scan opens only the runs it reaches.
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

  cursor(bounds?: ScanBounds): LayerCursor {
    const { runs, smallest, largest } = this;
    const end = bounds?.endExclusive;
    let r = 0;
    if (bounds?.start) {
      let hi = runs.length;
      while (r < hi) {
        const mid = (r + hi) >> 1;
        if (compareBytes(largest[mid]!, bounds.start) < 0) r = mid + 1;
        else hi = mid;
      }
    }
    const open = () =>
      r < runs.length && !(end && compareBytes(smallest[r]!, end) >= 0)
        ? runs[r]!.cursor(bounds)
        : undefined;
    let cur = open();
    return {
      peek() {
        while (cur) {
          const e = cur.peek();
          if (e) return e;
          r += 1;
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

export function arrayCursor(rows: readonly MemRow[]): LayerCursor {
  return entryCursor(
    rows.map((row) => {
      if (row.kind === "put" && row.value) {
        return { key: row.key, kind: "put" as const, value: row.value };
      }
      return { key: row.key, kind: "del" as const };
    }),
  );
}

/**
 * `cursors[0]` is newest. Yields live puts only, up to `limit`.
 * Tombstones are not counted and not yielded.
 */
export function* mergeCursors(
  cursors: readonly LayerCursor[],
  limit?: number,
): Generator<Entry> {
  const heap = new MinHeap();
  for (let s = 0; s < cursors.length; s++) pushPeek(heap, cursors, s);
  let yielded = 0;
  while (heap.length > 0) {
    const top = heap.pop()!;
    const winner = cursors[top.source]!.peek()!;
    cursors[top.source]!.next();
    pushPeek(heap, cursors, top.source);
    while (
      heap.length > 0 &&
      compareBytes(heap.peek()!.key, winner.key) === 0
    ) {
      const dup = heap.pop()!;
      cursors[dup.source]!.next();
      pushPeek(heap, cursors, dup.source);
    }
    if (winner.kind === "del") continue;
    yield {
      key: new Uint8Array(winner.key),
      value: new Uint8Array(winner.value!),
    };
    yielded += 1;
    if (limit !== undefined && yielded >= limit) return;
  }
}

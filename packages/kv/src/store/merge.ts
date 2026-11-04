import { compareBytes } from "../bytes.js";
import type { MemRow } from "./memtable.js";
import {
  entryCursor,
  lowerBoundKeys,
  type LayerCursor,
  type ScanBounds,
} from "./cursor.js";
import type { SstEntry, SstReader } from "./sst.js";
import type { Entry } from "../db.js";

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

export function lookupPin(
  rows: readonly MemRow[],
  key: Uint8Array,
): MemRow | undefined {
  const i = lowerBoundKeys(rows, key);
  const row = rows[i];
  if (!row || compareBytes(row.key, key) !== 0) return undefined;
  return row;
}

export function sliceRows(
  rows: readonly MemRow[],
  bounds?: ScanBounds,
): readonly MemRow[] {
  if (!bounds?.start && !bounds?.endExclusive) return rows;
  const start = bounds.start ? lowerBoundKeys(rows, bounds.start) : 0;
  const end = bounds.endExclusive
    ? lowerBoundKeys(rows, bounds.endExclusive)
    : rows.length;
  return rows.slice(start, end);
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

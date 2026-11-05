import { checkKey } from "./check.js";
import { ClosedError } from "./errors.js";
import type { Entry, Range } from "./db.js";
import type { MemRow } from "./store/memtable.js";
import type { ScanBounds } from "./store/cursor.js";
import {
  arrayCursor,
  lookupPin,
  mergeCursors,
  pointGet,
  sliceRows,
} from "./store/merge.js";
import type { SstReader } from "./store/sst.js";

export interface ViewSnapshot {
  /** WAL head seq pinned when the view opened. */
  readonly walHead: number;
  /** OPFS generation pinned when the view opened. */
  readonly generation: number;
  get(key: Uint8Array): Promise<Uint8Array | undefined>;
  range(range?: Range): AsyncIterable<Entry>;
}

export function boundsOf(range?: Range): ScanBounds | undefined {
  const start = range?.start ? checkKey(range.start) : undefined;
  const endExclusive = range?.endExclusive
    ? checkKey(range.endExclusive)
    : undefined;
  if (start && endExclusive) return { start, endExclusive };
  if (start) return { start };
  if (endExclusive) return { endExclusive };
  return undefined;
}

/**
 * Pinned mem rows plus the SST readers opened for that generation.
 * `rows.slice()` is the snapshot: later appends are not in the array.
 */
export class ViewSnapshotImpl implements ViewSnapshot {
  private closed = false;
  private readonly rows: readonly MemRow[];
  private readonly readers: readonly SstReader[];

  constructor(
    readonly walHead: number,
    readonly generation: number,
    rows: readonly MemRow[],
    readers: readonly SstReader[],
  ) {
    this.rows = rows.slice();
    this.readers = readers;
  }

  private ensureOpen(): void {
    if (this.closed) throw new ClosedError("view snapshot is closed");
  }

  /** Release after the view callback settles. */
  close(): void {
    this.closed = true;
  }

  async get(key: Uint8Array): Promise<Uint8Array | undefined> {
    this.ensureOpen();
    const k = checkKey(key);
    return pointGet(lookupPin(this.rows, k), this.readers, k);
  }

  async *range(range?: Range): AsyncIterable<Entry> {
    this.ensureOpen();
    const bounds = boundsOf(range);
    const slice = sliceRows(this.rows, bounds);
    for (const entry of mergeCursors(
      [
        arrayCursor(slice),
        ...this.readers.map((reader) => reader.cursor(bounds)),
      ],
      range?.limit,
    )) {
      this.ensureOpen();
      yield entry;
    }
  }
}

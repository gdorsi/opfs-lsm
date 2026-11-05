import { checkKey } from "./check.js";
import { ClosedError } from "./errors.js";
import type { Entry, Range } from "./db.js";
import type { MemRows } from "./store/memtable.js";
import type { ScanBounds } from "./store/cursor.js";
import {
  arrayCursor,
  mergeCursors,
  pointGet,
  type RunLevel,
} from "./store/merge.js";

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

/** Pinned memtable rows plus the SST readers opened for that generation. */
export class ViewSnapshotImpl implements ViewSnapshot {
  private closed = false;
  private readonly rows: MemRows;
  private readonly levels: readonly RunLevel[];

  constructor(
    readonly walHead: number,
    readonly generation: number,
    rows: MemRows,
    levels: readonly RunLevel[],
  ) {
    this.rows = rows;
    this.levels = levels;
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
    return pointGet(this.rows.get(k), this.levels, k);
  }

  async *range(range?: Range): AsyncIterable<Entry> {
    this.ensureOpen();
    const bounds = boundsOf(range);
    const slice = this.rows.range(bounds);
    for (const entry of mergeCursors(
      [
        arrayCursor(slice),
        ...this.levels.map((level) => level.cursor(bounds)),
      ],
      range?.limit,
    )) {
      this.ensureOpen();
      yield entry;
    }
  }
}

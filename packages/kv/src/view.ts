import { checkKey } from "./check.js";
import { ClosedError } from "./errors.js";
import type { Entry, Range } from "./db.js";
import type { MemRows } from "./store/memtable.js";
import type { LayerCursor, ScanBounds } from "./store/cursor.js";
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
  /**
   * One key-ordered scan of live puts per source (the memtable, each L0 run,
   * each deeper level), not merged. A key can show up in several scans, and an
   * older scan can hold a value a newer source overwrote or deleted, so a caller
   * confirms a hit with `get` on this snapshot. In exchange, a scan that only
   * filters skips the merge heap.
   */
  scanRuns(range?: Range): Iterable<Entry>[];
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

  scanRuns(range?: Range): Iterable<Entry>[] {
    this.ensureOpen();
    const bounds = boundsOf(range);
    return [
      this.livePuts(arrayCursor(this.rows.range(bounds)), true),
      ...this.levels.map((level) => this.livePuts(level.cursor(bounds), false)),
    ];
  }

  /** An SST cursor already hands out fresh bytes. Memtable bytes are shared, so copy those. */
  private *livePuts(cursor: LayerCursor, copy: boolean): Generator<Entry> {
    for (let e = cursor.peek(); e; cursor.next(), e = cursor.peek()) {
      this.ensureOpen();
      if (e.kind === "put") {
        yield copy
          ? { key: new Uint8Array(e.key), value: new Uint8Array(e.value!) }
          : { key: e.key, value: e.value! };
      }
    }
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

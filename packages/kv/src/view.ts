import { checkKey } from "./check.js";
import { ClosedError } from "./errors.js";
import type { Entry, Range } from "./db.js";
import type { MemRow, MemRows } from "./store/memtable.js";
import { settle, type ScanBounds } from "./store/cursor.js";
import {
  arrayCursor,
  mergeCursors,
  pointGet,
  scanMatching,
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

/**
 * `range` over memtable `rows` already cut to `bounds` and the levels under
 * them: every live put, or with `valueContains` only the matching ones.
 */
export function scanLayers(
  rows: readonly MemRow[],
  levels: readonly RunLevel[],
  bounds: ScanBounds | undefined,
  range: Range | undefined,
): AsyncGenerator<Entry> {
  const patterns = range?.valueContains;
  return patterns && patterns.length > 0
    ? scanMatching(rows, levels, patterns, bounds, range.limit)
    : mergeCursors(
        [arrayCursor(rows), ...levels.map((level) => level.cursor(bounds))],
        range?.limit,
      );
}

/**
 * Pinned memtable rows plus the SST readers opened for that generation.
 * `hold` keeps those readers open and returns its release, so a `range`
 * iterator that outlives the view callback still reads open files.
 */
export class ViewSnapshotImpl implements ViewSnapshot {
  private closed = false;

  constructor(
    readonly walHead: number,
    readonly generation: number,
    private readonly rows: MemRows,
    private readonly levels: readonly RunLevel[],
    private readonly hold: () => () => void,
  ) {}

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
    const row = this.rows.get(k);
    return settle(() => pointGet(row, this.levels, k));
  }

  async *range(range?: Range): AsyncIterable<Entry> {
    this.ensureOpen();
    const bounds = boundsOf(range);
    const release = this.hold();
    try {
      for await (const entry of scanLayers(this.rows.range(bounds), this.levels, bounds, range)) {
        this.ensureOpen();
        yield entry;
      }
    } finally {
      release();
    }
  }
}

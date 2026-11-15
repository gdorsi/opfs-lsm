import { checkKey } from "./check.js";
import { ClosedError } from "./errors.js";
import type { Entry, Range } from "./db.js";
import type { MemRow, MemRows } from "./store/memtable.js";
import { entryCursor, untilHit, type ScanBounds } from "./store/cursor.js";
import type { Marks } from "./store/marks.js";
import {
  countOf,
  entriesOf,
  liveStep,
  matchingStep,
  pointGet,
  type RunLevel,
  type ScanStep,
} from "./store/read.js";

export interface ViewSnapshot {
  /** The seq of the last record the snapshot includes, as write acks and `changes` count it. */
  readonly seq: number;
  get(key: Uint8Array): Promise<Uint8Array | undefined>;
  range(range?: Range): AsyncIterable<Entry>;
  /** How many entries `range` would yield, `limit` included, without copying them. */
  count(range?: Range): Promise<number>;
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
 * them, one entry at a time: every live put, or with `valueContains` only
 * the matching ones. `limit` is left to the caller.
 */
function scanStep(
  rows: readonly MemRow[],
  levels: readonly RunLevel[],
  at: Marks,
  bounds: ScanBounds | undefined,
  range: Range | undefined,
): ScanStep {
  const patterns = range?.valueContains;
  const reverse = range?.reverse ?? false;
  return patterns && patterns.length > 0
    ? matchingStep(rows, levels, patterns, at, bounds, reverse)
    : liveStep([entryCursor(rows, reverse), ...levels.map((level) => level.cursor(bounds, reverse, at))], at, reverse);
}

/** The entries `range` yields over memtable `rows` already cut to `bounds` and the levels under them. */
export function scanLayers(
  rows: readonly MemRow[],
  levels: readonly RunLevel[],
  at: Marks,
  bounds: ScanBounds | undefined,
  range: Range | undefined,
): AsyncGenerator<Entry> {
  return entriesOf(scanStep(rows, levels, at, bounds, range), range?.limit);
}

/** How many entries `scanLayers` would yield, without copying them. */
export function countLayers(
  rows: readonly MemRow[],
  levels: readonly RunLevel[],
  at: Marks,
  bounds: ScanBounds | undefined,
  range: Range | undefined,
): Promise<number> {
  return countOf(scanStep(rows, levels, at, bounds, range), range?.limit);
}

/**
 * Pinned memtable rows plus the SST readers opened for that generation, and
 * the read point taken with them.
 * `hold` keeps those readers open and returns its release, so a `range`
 * iterator that outlives the view callback still reads open files.
 */
export class ViewSnapshotImpl implements ViewSnapshot {
  private closed = false;

  constructor(
    readonly seq: number,
    private readonly rows: MemRows,
    private readonly levels: readonly RunLevel[],
    private readonly at: Marks,
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
    return untilHit(() => pointGet(row, this.levels, k, this.at));
  }

  async count(range?: Range): Promise<number> {
    this.ensureOpen();
    const bounds = boundsOf(range);
    const release = this.hold();
    try {
      return await countLayers(this.rows.range(bounds), this.levels, this.at, bounds, range);
    } finally {
      release();
    }
  }

  async *range(range?: Range): AsyncIterable<Entry> {
    this.ensureOpen();
    const bounds = boundsOf(range);
    const release = this.hold();
    try {
      for await (const entry of scanLayers(this.rows.range(bounds), this.levels, this.at, bounds, range)) {
        this.ensureOpen();
        yield entry;
      }
    } finally {
      release();
    }
  }
}

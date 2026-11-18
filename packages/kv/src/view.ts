import { checkKey } from "./check.js";
import { ClosedError, ConstraintError } from "./errors.js";
import type { Entry, Range } from "./db.js";
import type { MemRow, MemRows } from "./store/memtable.js";
import { entryCursor, lowerBoundKeys, Miss, untilHit, type ScanBounds } from "./store/cursor.js";
import type { Marks } from "./store/marks.js";
import {
  countOf,
  entriesOf,
  liveCount,
  liveStep,
  seekOffset,
  matchingStep,
  pointGet,
  readKeys,
  type RunLevel,
  type ScanStep,
} from "./store/read.js";

interface Joined {
  readonly entry: Entry;
  /** Undefined when `keyOf` returned no key or the key has no value. */
  readonly joined: Uint8Array | undefined;
}

export interface ViewSnapshot {
  /** The seq of the last record the snapshot includes, as write acks and `changes` count it. */
  readonly seq: number;
  get(key: Uint8Array): Promise<Uint8Array | undefined>;
  range(range?: Range): AsyncIterable<Entry>;
  /** How many entries `range` would yield, `limit` included, without copying them. */
  count(range?: Range): Promise<number>;
  /**
   * Scan `range` and join each entry to the value at `keyOf(entry)`, as an
   * index entry joins its row. The scan and the reads see the snapshot, so a
   * page load that makes one wait does not change what the next sees.
   */
  rangeJoin(range: Range, keyOf: (entry: Entry) => Uint8Array | undefined): Promise<Joined[]>;
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

/**
 * The entries `range` yields over memtable `rows` already cut to `bounds` and
 * the levels under them. A large `offset` starts the scan past most of what
 * it skips (`seekOffset`), and walks the rest.
 */
export async function* scanLayers(
  rows: readonly MemRow[],
  levels: readonly RunLevel[],
  at: Marks,
  bounds: ScanBounds | undefined,
  range: Range | undefined,
): AsyncGenerator<Entry> {
  let offset = offsetOf(range);
  if (!range?.valueContains?.length) {
    const reverse = range?.reverse ?? false;
    const seek = () => seekOffset(rows, levels, at, bounds, offset, reverse);
    const first = seek();
    const found = first instanceof Miss ? await untilHit(seek, first) : first;
    if (found) {
      const cut = lowerBoundKeys(rows, found.at);
      rows = reverse ? rows.slice(0, cut) : rows.slice(cut);
      bounds = reverse ? { ...bounds, endExclusive: found.at } : { ...bounds, start: found.at };
      offset -= found.skipped;
    }
  }
  yield* entriesOf(scanStep(rows, levels, at, bounds, range), range?.limit, offset);
}

/** `range.offset`, 0 when not given. `ConstraintError` unless it is a whole number from 0 up. */
function offsetOf(range: Range | undefined): number {
  const offset = range?.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new ConstraintError(`offset must be a whole number from 0 up: got ${offset}`);
  return offset;
}

/**
 * How many entries `scanLayers` would yield. With no `valueContains` it adds
 * up what the rows and the runs say (`liveCount`) and reads at most two
 * blocks of each level. It scans, without copying an entry, when they cannot
 * say.
 */
export async function countLayers(
  rows: readonly MemRow[],
  levels: readonly RunLevel[],
  at: Marks,
  bounds: ScanBounds | undefined,
  range: Range | undefined,
): Promise<number> {
  const offset = offsetOf(range);
  const limit = range?.limit;
  if (!range?.valueContains?.length) {
    const read = () => liveCount(rows, levels, at, bounds);
    const first = read();
    const live = first instanceof Miss ? await untilHit(read, first) : first;
    if (live !== undefined) {
      const left = Math.max(0, live - offset);
      return limit === undefined ? left : Math.min(left, limit);
    }
  }
  return countOf(scanStep(rows, levels, at, bounds, range), limit, offset);
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
    /** Throws `ClosedError` once the handle closed, so a read that fails after `destroyDb` says so. */
    private readonly handleOpen: () => void,
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
    try {
      return await untilHit(() => pointGet(row, this.levels, k, this.at));
    } catch (err) {
      this.handleOpen();
      throw err;
    }
  }

  async rangeJoin(range: Range, keyOf: (entry: Entry) => Uint8Array | undefined): Promise<Joined[]> {
    this.ensureOpen();
    const bounds = boundsOf(range);
    const release = this.hold();
    try {
      const out: { entry: Entry; joined: Uint8Array | undefined }[] = [];
      const keys: Uint8Array[] = [];
      const owners: typeof out = [];
      for await (const entry of scanLayers(this.rows.range(bounds), this.levels, this.at, bounds, range)) {
        const hit = { entry, joined: undefined };
        out.push(hit);
        const key = keyOf(entry);
        if (key === undefined) continue;
        keys.push(checkKey(key));
        owners.push(hit);
      }
      // One read for every key, so the pages they lack load together.
      const read = () => readKeys(this.rows, keys, this.levels, this.at);
      const first = read();
      const values = first instanceof Miss ? await untilHit(read, first) : first;
      values.forEach((value, i) => (owners[i]!.joined = value));
      return out;
    } catch (err) {
      this.handleOpen();
      throw err;
    } finally {
      release();
    }
  }

  async count(range?: Range): Promise<number> {
    this.ensureOpen();
    const bounds = boundsOf(range);
    const release = this.hold();
    try {
      return await countLayers(this.rows.range(bounds), this.levels, this.at, bounds, range);
    } catch (err) {
      this.handleOpen();
      throw err;
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
    } catch (err) {
      this.handleOpen();
      throw err;
    } finally {
      release();
    }
  }
}

import { checkKey } from "./check.js";
import { ClosedError } from "./errors.js";
import type { Entry, Range } from "./db.js";
import type { MemRow, MemRows } from "./store/memtable.js";
import { entryCursor, entryOf, Miss, untilHit, type ScanBounds } from "./store/cursor.js";
import type { Marks } from "./store/marks.js";
import {
  countOf,
  liveStep,
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
 * the matching ones, and no more than `limit`. It is a sync step and not an
 * async iterator, so the `range` a caller reads is the only async generator
 * an entry passes through: each one costs several promise turns per entry.
 */
export function scanStep(
  rows: readonly MemRow[],
  levels: readonly RunLevel[],
  at: Marks,
  bounds: ScanBounds | undefined,
  range: Range | undefined,
): ScanStep {
  const patterns = range?.valueContains;
  const reverse = range?.reverse ?? false;
  const step =
    patterns && patterns.length > 0
      ? matchingStep(rows, levels, patterns, at, bounds, reverse)
      : liveStep([entryCursor(rows, reverse), ...levels.map((level) => level.cursor(bounds, reverse, at))], at, reverse);
  const limit = range?.limit;
  if (limit === undefined) return step;
  let n = 0;
  return () => {
    if (!(n < limit)) return undefined;
    const e = step();
    if (e && !(e instanceof Miss)) n++;
    return e;
  };
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
      const step = scanStep(this.rows.range(bounds), this.levels, this.at, bounds, range);
      for (;;) {
        let e = step();
        if (e instanceof Miss) e = await untilHit(step, e);
        if (!e) break;
        const hit = { entry: entryOf(e), joined: undefined };
        out.push(hit);
        const key = keyOf(hit.entry);
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
      return await countOf(scanStep(this.rows.range(bounds), this.levels, this.at, bounds, range));
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
      const step = scanStep(this.rows.range(bounds), this.levels, this.at, bounds, range);
      for (;;) {
        let e = step();
        if (e instanceof Miss) e = await untilHit(step, e);
        if (!e) return;
        this.ensureOpen();
        yield entryOf(e);
      }
    } catch (err) {
      this.handleOpen();
      throw err;
    } finally {
      release();
    }
  }
}

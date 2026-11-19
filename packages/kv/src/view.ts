import { checkKey } from "./check.js";
import { ClosedError } from "./errors.js";
import type { Entry, Range } from "./db.js";
import type { MemRow, MemRows } from "./store/memtable.js";
import { entryCursor, entryOf, Miss, untilHit, type LayerEntry, type ScanBounds } from "./store/cursor.js";
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
 * async iterator, so `range`, `count` and `rangeJoin` wait only on a miss.
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
      : liveStep([entryCursor(rows, reverse), ...levels.map((level) => level.cursor(bounds, reverse, at))], at, reverse, bounds);
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

/** What a `range` iterator asks of the handle or view it reads. */
type ScanHost = {
  /**
   * Runs at the first `next()`: checks the host is open, builds the scan, and
   * takes the layers last, so nothing can throw while it holds them.
   */
  start(): { readonly step: ScanStep; readonly release: () => void };
  /** Throws when the host closed. Runs before each entry is handed out. */
  check(): void;
  /** Runs when the scan threw. Throws `ClosedError` in its place when the handle closed. */
  failed(): void;
};

type Step = IteratorResult<Entry, undefined>;

/** What an async generator's iterator inherits: `Symbol.asyncIterator`, and `Symbol.asyncDispose` where the engine has it. */
const ASYNC_ITERATOR: object = Object.getPrototypeOf(Object.getPrototypeOf((async function* () {}).prototype));

/**
 * The async iterator of a `range`, written by hand because an async generator
 * spends several promise turns on every entry. A `next()` whose entry is in
 * memory resolves in the call itself. It keeps what a generator promises a
 * caller: calls are answered in the order they were made, a `return()` or a
 * failed read ends the scan and frees its layers once, and nothing is taken
 * before the first `next()`. A `throw()` ends it as a failed read does.
 * `return()` ignores its argument.
 */
export function rangeScan(host: ScanHost): AsyncIterableIterator<Entry, undefined> {
  /** Set from the first `next()` until the scan ends. */
  let scan: { readonly step: ScanStep; readonly release: () => void } | undefined;
  let ended = false;
  /** The last call still waiting for bytes. A call made meanwhile runs after it. */
  let tail: Promise<unknown> | undefined;

  function finish(): Step {
    ended = true;
    const release = scan?.release;
    scan = undefined;
    release?.();
    return { value: undefined, done: true };
  }

  function fail(err: unknown): never {
    finish();
    host.failed();
    throw err;
  }

  function emit(e: LayerEntry | undefined): Step {
    if (!e) return finish();
    host.check();
    return { value: entryOf(e), done: false };
  }

  async function afterMiss(step: ScanStep, miss: Miss): Promise<Step> {
    try {
      return emit(await untilHit(step, miss));
    } catch (err) {
      return fail(err);
    }
  }

  function advance(): Step | Promise<Step> {
    if (ended) return { value: undefined, done: true };
    try {
      const { step } = (scan ??= host.start());
      const e = step();
      return e instanceof Miss ? afterMiss(step, e) : emit(e);
    } catch (err) {
      return fail(err);
    }
  }

  /** Runs `op` now, or after the calls that wait for bytes. A call that waits is the one the next runs after. */
  function run(op: () => Step | Promise<Step>): Promise<Step> {
    let result: Promise<Step>;
    if (tail) result = tail.then(op, op);
    else {
      let now: Step | Promise<Step>;
      try {
        now = op();
      } catch (err) {
        return Promise.reject(err);
      }
      if (!(now instanceof Promise)) return Promise.resolve(now);
      result = now;
    }
    tail = result;
    const settled = () => {
      if (tail === result) tail = undefined;
    };
    result.then(settled, settled);
    return result;
  }

  const iterator: AsyncIterableIterator<Entry, undefined> = Object.create(ASYNC_ITERATOR);
  iterator.next = () => run(advance);
  iterator.return = () => run(finish);
  // As a generator paused at a yield: the error passes through the scan's own handling. One not started, or over, only rejects.
  iterator.throw = (err) =>
    run(() => {
      if (scan) fail(err);
      ended = true;
      throw err;
    });
  return iterator;
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

  range(range?: Range): AsyncIterable<Entry> {
    return rangeScan({
      start: () => {
        this.ensureOpen();
        const bounds = boundsOf(range);
        const step = scanStep(this.rows.range(bounds), this.levels, this.at, bounds, range);
        return { step, release: this.hold() };
      },
      check: () => this.ensureOpen(),
      failed: this.handleOpen,
    });
  }
}

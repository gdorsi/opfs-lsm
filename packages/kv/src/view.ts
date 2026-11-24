import { checkKey } from "./check.js";
import { ClosedError, ConstraintError } from "./errors.js";
import type { Entry, Range } from "./db.js";
import type { MemRow, MemRows } from "./store/memtable.js";
import { entryCursor, entryOf, keyOf, Miss, untilHit, valueOf, type LayerEntry, type ScanBounds } from "./store/cursor.js";
import type { Marks } from "./store/marks.js";
import {
  countOf,
  liveStep,
  matchingStep,
  keysReader,
  type RunLevel,
  type ScanStep,
} from "./store/read.js";

interface Joined<T> {
  readonly entry: Entry;
  /** Undefined when `keyOf` returned no key or the key has no value. */
  readonly joined: T | undefined;
}

/**
 * What a read makes of a value in place of a copy. It gets the bytes where
 * they are stored, so it must neither change them nor keep them past its
 * return.
 */
export type Decode<T> = (value: Uint8Array) => T;

export interface ViewSnapshot {
  /** The seq of the last record the snapshot includes, as write acks and `changes` count it. */
  readonly seq: number;
  get(key: Uint8Array): Promise<Uint8Array | undefined>;
  /** See `Db.getMany`. */
  getMany(keys: readonly Uint8Array[]): Promise<(Uint8Array | undefined)[]>;
  getMany<T>(keys: readonly Uint8Array[], decode: Decode<T>): Promise<(T | undefined)[]>;
  range(range?: Range): AsyncIterable<Entry>;
  /** How many entries `range` would yield, `limit` included, without copying them. */
  count(range?: Range): Promise<number>;
  /**
   * Every entry of `range` in one call, each value as `decode` makes it from the bytes where
   * they are stored. `decode` runs once per entry, in scan order.
   */
  rangeValues<T>(range: Range, decode: Decode<T>): Promise<{ key: Uint8Array; value: T }[]>;
  /**
   * Scan `range` and join each entry to the value at `keyOf(entry)`, as an
   * index entry joins its row. The scan and the reads see the snapshot, so a
   * page load that makes one wait does not change what the next sees. With
   * `decode`, `joined` is what it returns for the value.
   */
  rangeJoin(range: Range, keyOf: (entry: Entry) => Uint8Array | undefined): Promise<Joined<Uint8Array>[]>;
  rangeJoin<T>(range: Range, keyOf: (entry: Entry) => Uint8Array | undefined, decode: Decode<T>): Promise<Joined<T>[]>;
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
 * the matching ones, past the first `offset` and no more than `limit`. It is a sync step and not an
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
  const limit = range?.limit ?? Number.POSITIVE_INFINITY;
  let skip = range?.offset ?? 0;
  // A whole number or Infinity, which has no remainder to compare.
  for (const n of [limit, skip]) if (!(n >= 0) || n % 1 > 0) throw new ConstraintError(`limit and offset must be integers >= 0: got ${n}`);
  if (limit === Number.POSITIVE_INFINITY && skip === 0) return step;
  let n = 0;
  return () => {
    if (!(n < limit)) return undefined;
    for (; skip > 0; skip--) {
      const e = step();
      if (!e || e instanceof Miss) return e;
    }
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
    return (await this.getMany<Uint8Array>([key]))[0];
  }

  async getMany<T>(keys: readonly Uint8Array[], decode?: Decode<T>): Promise<(T | undefined)[]> {
    this.ensureOpen();
    try {
      return await this.read(keys.map(checkKey), decode);
    } catch (err) {
      this.handleOpen();
      throw err;
    }
  }

  /** `getMany` past its checks: `keys` are checked and the caller answers for the snapshot being open. */
  private async read<T>(keys: readonly Uint8Array[], decode: Decode<T> | undefined): Promise<(T | undefined)[]> {
    const mems = keys.map((k) => this.rows.get(k));
    const attempt = keysReader(mems, keys, this.at, decode);
    const read = () => attempt(this.levels);
    const first = read();
    return first instanceof Miss ? untilHit(read, first) : first;
  }

  /**
   * What `each` makes of every entry of `range`, in scan order and once each, then what `after`
   * makes of that. Holds the readers until `after` settles.
   */
  private async scan<R, O = R[]>(range: Range, each: (e: LayerEntry) => R, after?: (out: R[]) => Promise<O>): Promise<O> {
    this.ensureOpen();
    const bounds = boundsOf(range);
    const release = this.hold();
    try {
      const out: R[] = [];
      const step = scanStep(this.rows.range(bounds), this.levels, this.at, bounds, range);
      for (;;) {
        let e = step();
        if (e instanceof Miss) e = await untilHit(step, e);
        if (!e) return await (after ? after(out) : (out as O));
        out.push(each(e));
      }
    } catch (err) {
      this.handleOpen();
      throw err;
    } finally {
      release();
    }
  }

  rangeJoin<T>(range: Range, keyOf: (entry: Entry) => Uint8Array | undefined, decode?: Decode<T>): Promise<Joined<T>[]> {
    const keys: Uint8Array[] = [];
    const owners: { entry: Entry; joined: T | undefined }[] = [];
    return this.scan(
      range,
      (e) => {
        const hit = { entry: entryOf(e), joined: undefined };
        const key = keyOf(hit.entry);
        if (key !== undefined) {
          keys.push(checkKey(key));
          owners.push(hit);
        }
        return hit;
      },
      async (out) => {
        // One read for every key, so the pages they lack load together.
        (await this.read(keys, decode)).forEach((value, i) => (owners[i]!.joined = value));
        return out;
      },
    );
  }

  rangeValues<T>(range: Range, decode: Decode<T>): Promise<{ key: Uint8Array; value: T }[]> {
    return this.scan(range, (e) => ({ key: keyOf(e), value: decode(valueOf(e)) }));
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

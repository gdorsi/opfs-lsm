import { compareBytes, containsAll } from "../bytes.js";

/** A matching put from a run's block filter, which reports no seq. */
export type ScanHit = {
  readonly key: Uint8Array;
  readonly kind: "put" | "del";
  /** Present iff kind === "put". */
  readonly value?: Uint8Array;
  readonly seq?: number;
};

export type LayerEntry = ScanHit & {
  /** The WAL seq that wrote the entry. */
  readonly seq: number;
};

export type ScanBounds = {
  readonly start?: Uint8Array;
  readonly endExclusive?: Uint8Array;
};

/**
 * In-order cursor. `peek` is idempotent. `next` drops the peeked entry and
 * is only legal after a `peek` that returned one. `peek` returns a Miss when
 * the next entry's bytes are not resident: the cursor has not moved, and
 * peeking again after `ready` resolves continues from the same place.
 */
export interface LayerCursor<E extends ScanHit = LayerEntry> {
  peek(): E | undefined | Miss;
  next(): void;
}

export function lowerBoundKeys(
  entries: readonly { readonly key: Uint8Array }[],
  key: Uint8Array,
): number {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compareBytes(entries[mid]!.key, key) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function entryCursor<E extends ScanHit>(entries: readonly E[], reverse = false): LayerCursor<E> {
  const step = reverse ? -1 : 1;
  let i = reverse ? entries.length - 1 : 0;
  return {
    peek() {
      return entries[i];
    },
    next() {
      i += step;
    },
  };
}

/** A cache key and the value loaded for it. */
export type Fill = readonly [key: number, value: unknown];

/**
 * Bytes a sync read needs and does not have yet. The read has already
 * started, and `ready` resolves with what it loaded. The cache may evict
 * those bytes at once, so retry through a `ReadSet`, which keeps them. A
 * value rather than an exception, so a merge holding several sources keeps
 * their positions.
 */
export class Miss {
  constructor(readonly ready: Promise<readonly Fill[]>) {}
}

export type Maybe<T> = T | Miss;

/** One Miss that is ready when all of `misses` are. */
export function allMissed(misses: readonly Miss[]): Miss {
  if (misses.length === 1) return misses[0]!;
  return new Miss(Promise.all(misses.map((m) => m.ready)).then((fills) => fills.flat()));
}

/** The puts of `cursor` whose value holds every pattern. */
export function filterCursor<E extends ScanHit>(cursor: LayerCursor<E>, patterns: readonly Uint8Array[]): LayerCursor<E> {
  return {
    peek() {
      for (;;) {
        const e = cursor.peek();
        if (!e || e instanceof Miss || (e.kind === "put" && containsAll(e.value!, patterns))) return e;
        cursor.next();
      }
    },
    next() {
      cursor.next();
    },
  };
}

/**
 * What one operation has read so far, held outside the page cache. A cache
 * lookup made inside `attempt` takes its value from here and adds what it
 * finds, and `settle` adds what each Miss loaded. So a retry misses only on
 * bytes no earlier round asked for, whatever the cache evicted in between.
 */
export class ReadSet {
  private readonly held: HeldReads = new Map();

  /** Runs a read against this set. `read` must be synchronous: a lookup after an await would not see the set. */
  attempt<T>(read: () => T): T {
    const outer = reading;
    reading = this.held;
    try {
      return read();
    } finally {
      reading = outer;
    }
  }

  /** Re-runs `read` until it stops missing. `first` is a result `read` already gave. */
  async settle<T>(read: () => Maybe<T>, first: Maybe<T> = this.attempt(read)): Promise<T> {
    for (let r = first; ; r = this.attempt(read)) {
      if (!(r instanceof Miss)) return r;
      this.add(await r.ready);
    }
  }

  /** `miss`, with what it loads added to this set, for a caller that awaits it itself. */
  keep(miss: Miss): Miss {
    return new Miss(
      miss.ready.then((fills) => {
        this.add(fills);
        return fills;
      }),
    );
  }

  private add(fills: readonly Fill[]): void {
    for (const [key, value] of fills) this.held.set(key, value);
  }
}

/** Cache key to value. Run ids are unique across caches, so a key names one value. */
type HeldReads = Map<number, unknown>;

// Set only for the span of one sync `attempt`, so a read never sees another operation's set.
let reading: HeldReads | undefined;

/** The set of the read now running, if it has one. */
export function heldReads(): HeldReads | undefined {
  return reading;
}

/**
 * Re-runs a sync read until it stops missing, holding what it loads. Pass
 * the Miss a first try outside any set returned, so the usual hit
 * allocates nothing.
 */
export function untilHit<T>(attempt: () => Maybe<T>, first?: Miss): Promise<T> {
  return new ReadSet().settle(attempt, first);
}

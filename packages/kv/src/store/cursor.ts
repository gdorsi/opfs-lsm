import { compareBytes, compareFrom, containsAll } from "../bytes.js";
import type { Entry } from "../db.js";
import type { Seq } from "../seq.js";

type Version = {
  readonly key: Uint8Array;
  readonly kind: "put" | "del";
  /** The WAL seq that wrote the entry. */
  readonly seq: Seq;
};

/**
 * A record of a run, read where it is in `block`, which is never written once
 * read. Its key is the block's `prefixLength` bytes at `prefixAt`, then the
 * `suffixLength` bytes at `suffixAt`. `key` copies them out the first time it
 * is asked, and `compareKey` reads them in place, so a scan that counts,
 * skips or drops the record copies nothing, and one that keeps it copies the
 * key and the value once each.
 */
export class BlockEntry {
  private copied: Uint8Array | undefined = undefined;

  constructor(
    readonly block: Uint8Array,
    readonly kind: "put" | "del",
    /** The WAL seq that wrote the entry. */
    readonly seq: Seq,
    /** The value is `block[valueAt, valueAt + valueLength)`, empty for a delete. */
    readonly valueAt: number,
    readonly valueLength: number,
    private readonly prefixAt: number,
    private readonly prefixLength: number,
    private readonly suffixAt: number,
    private readonly suffixLength: number,
  ) {}

  /** A copy that owns its buffer, made once. */
  get key(): Uint8Array {
    let k = this.copied;
    if (k === undefined) {
      const { block, prefixAt, prefixLength, suffixAt } = this;
      // The record's own bytes always sit before its suffix, so one slice
      // copies the suffix to its place and leaves room for the prefix.
      k = block.slice(suffixAt - prefixLength, suffixAt + this.suffixLength);
      for (let i = 0; i < prefixLength; i++) k[i] = block[prefixAt + i]!;
      this.copied = k;
    }
    return k;
  }

  /** `compareFrom(this.key, key, from)`, on the bytes in the block. */
  compareKey(key: Uint8Array, from: number): number {
    const { block, prefixAt, prefixLength } = this;
    const length = prefixLength + this.suffixLength;
    const n = Math.min(length, key.length);
    const inPrefix = Math.min(prefixLength, n);
    let i = from;
    for (; i < inPrefix; i++) {
      const d = block[prefixAt + i]! - key[i]!;
      if (d !== 0) return d;
    }
    const shift = this.suffixAt - prefixLength;
    for (; i < n; i++) {
      const d = block[shift + i]! - key[i]!;
      if (d !== 0) return d;
    }
    return length - key.length;
  }

  /** `compareFrom(this.key, other.key, from)`, on the bytes of both blocks. */
  compareEntry(other: BlockEntry, from: number): number {
    const a = this.block;
    const b = other.block;
    const aPrefix = this.prefixLength;
    const bPrefix = other.prefixLength;
    const aLength = aPrefix + this.suffixLength;
    const bLength = bPrefix + other.suffixLength;
    const n = Math.min(aLength, bLength);
    // Byte i of a key is at `prefixAt + i` inside the prefix and at `shift + i` past it.
    const aShift = this.suffixAt - aPrefix;
    const bShift = other.suffixAt - bPrefix;
    let i = from;
    for (const end = Math.min(aPrefix, bPrefix, n); i < end; i++) {
      const d = a[this.prefixAt + i]! - b[other.prefixAt + i]!;
      if (d !== 0) return d;
    }
    // Where only the longer prefix still runs.
    const aAt = aPrefix > bPrefix ? this.prefixAt : aShift;
    const bAt = bPrefix > aPrefix ? other.prefixAt : bShift;
    for (const end = Math.min(Math.max(aPrefix, bPrefix), n); i < end; i++) {
      const d = a[aAt + i]! - b[bAt + i]!;
      if (d !== 0) return d;
    }
    for (; i < n; i++) {
      const d = a[aShift + i]! - b[bShift + i]!;
      if (d !== 0) return d;
    }
    return aLength - bLength;
  }

  /** How many leading bytes of `key` every record of this block shares with it, at most the block's prefix. */
  prefixShared(key: Uint8Array): number {
    const { block, prefixAt } = this;
    const n = Math.min(this.prefixLength, key.length);
    let i = 0;
    while (i < n && block[prefixAt + i] === key[i]) i++;
    return i;
  }
}

/**
 * Where a version's bytes are. A memtable row lends its own key and value, so
 * a read copies both to hand them out. A record of a run is a `BlockEntry`.
 */
export type LayerEntry =
  | (Version & {
      /** Present iff kind === "put". */
      readonly value?: Uint8Array;
      readonly block?: undefined;
    })
  | BlockEntry;

/** `compareFrom(a.key, b.key, from)`, without copying the key of a run's record. */
export function compareEntries(a: LayerEntry, b: LayerEntry, from: number): number {
  if (a.block) return b.block ? a.compareEntry(b, from) : a.compareKey(b.key, from);
  if (b.block) return -b.compareKey(a.key, from);
  return compareFrom(a.key, b.key, from);
}

/** A put's value, to read where it is. */
export function valueOf(e: LayerEntry): Uint8Array {
  return e.block ? e.block.subarray(e.valueAt, e.valueAt + e.valueLength) : e.value!;
}

/** A put as a read hands it out: a key and a value that own their buffers. */
export function entryOf(e: LayerEntry): Entry {
  return e.block
    ? { key: e.key, value: e.block.slice(e.valueAt, e.valueAt + e.valueLength) }
    : { key: new Uint8Array(e.key), value: new Uint8Array(e.value!) };
}

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
export interface LayerCursor {
  peek(): LayerEntry | undefined | Miss;
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

export function entryCursor(entries: readonly LayerEntry[], reverse = false): LayerCursor {
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
export function filterCursor(cursor: LayerCursor, patterns: readonly Uint8Array[]): LayerCursor {
  return {
    peek() {
      for (;;) {
        const e = cursor.peek();
        if (!e || e instanceof Miss || (e.kind === "put" && containsAll(valueOf(e), patterns))) return e;
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

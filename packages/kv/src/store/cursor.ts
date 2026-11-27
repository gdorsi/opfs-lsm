import { compareFrom, containsAll, copyOut } from "../bytes.js";
import { asSeq, type Seq } from "../seq.js";
import type { MemRow } from "./memtable.js";

/** The u64 seq at `block[o]`, read as two u32 halves, which is exact below 2^53 and allocates no BigInt. */
export function seqIn(block: Uint8Array, o: number): Seq {
  const low = (block[o]! | (block[o + 1]! << 8) | (block[o + 2]! << 16)) + block[o + 3]! * 2 ** 24;
  const high = (block[o + 4]! | (block[o + 5]! << 8) | (block[o + 6]! << 16)) + block[o + 7]! * 2 ** 24;
  return asSeq(low + high * 2 ** 32);
}

/** The prefix of a record whose block shares none. */
export const NO_PREFIX = new Uint8Array(0);

/**
 * A record of a run, read where it is in `block`, which is never written once
 * read. Its key is `prefix`, the bytes every key of its block starts with,
 * then the `suffixLength` bytes at `suffixAt`. `key` copies them out the
 * first time it is asked, and the compares read them in place until the
 * record waits through a second one, so a scan that counts, skips or drops
 * the record copies no value and seldom a key, and one that keeps it copies
 * the key and the value once each.
 */
export class BlockEntry {
  /** The copy `key` made. Null once another record was compared with this one, see `waits`. */
  private copied: Uint8Array | null | undefined = undefined;

  constructor(
    readonly block: Uint8Array,
    readonly kind: "put" | "del",
    /** Where the record's u64 seq is in `block`. */
    private readonly seqAt: number,
    /** The value is `block[valueAt, valueAt + valueLength)`, empty for a delete. */
    readonly valueAt: number,
    readonly valueLength: number,
    /** A view of `block`, shared by every record of it. */
    private readonly prefix: Uint8Array,
    private readonly suffixAt: number,
    private readonly suffixLength: number,
  ) {}

  /** The WAL seq that wrote the entry. Read when asked: a scan needs it only under a range delete. */
  get seq(): Seq {
    return seqIn(this.block, this.seqAt);
  }

  /** A copy to hand out, as `copyOut` makes one, made once unless the app detached it. */
  get key(): Uint8Array {
    let k = this.copied;
    const { prefix, suffixLength } = this;
    // A pooled copy reads empty once the app transfers the buffer of another copy in its pool.
    if (!k || k.length !== prefix.length + suffixLength) {
      const { block, suffixAt } = this;
      const from = suffixAt - prefix.length;
      const to = suffixAt + suffixLength;
      // The record's own bytes always sit before its suffix, so one copy
      // puts the suffix in its place and leaves room for the prefix.
      k = to - from > 64 ? copyOut(block.subarray(from, to)) : block.slice(from, to);
      if (prefix.length > 0) k.set(prefix);
      this.copied = k;
    }
    return k;
  }

  /**
   * Whether a record was compared with this one before. A record a merge
   * keeps waiting is compared with every record that passes it, so from the
   * second on its key is worth a copy, which compares faster than two blocks.
   */
  private waits(): boolean {
    if (this.copied !== undefined) return true;
    this.copied = null;
    return false;
  }

  /** `compareFrom(this.key, key, from)`, on the bytes in the block. */
  compareKey(key: Uint8Array, from: number): number {
    const { block, prefix } = this;
    const length = prefix.length + this.suffixLength;
    const n = Math.min(length, key.length);
    let i = from;
    for (const end = Math.min(prefix.length, n); i < end; i++) {
      const d = prefix[i]! - key[i]!;
      if (d !== 0) return d;
    }
    const shift = this.suffixAt - prefix.length;
    for (; i < n; i++) {
      const d = block[shift + i]! - key[i]!;
      if (d !== 0) return d;
    }
    return length - key.length;
  }

  /** `compareFrom(this.key, other.key, from)`, with no copy of this key and none of the other's the first time it is asked. */
  compareEntry(other: BlockEntry, from: number): number {
    if (other.waits()) return this.compareKey(other.key, from);
    const aPrefix = this.prefix.length;
    const bPrefix = other.prefix.length;
    const aLength = aPrefix + this.suffixLength;
    const bLength = bPrefix + other.suffixLength;
    const n = Math.min(aLength, bLength);
    // Byte i of a key is `prefix[i]` inside the prefix and `block[shift + i]` past it.
    const aShift = this.suffixAt - aPrefix;
    const bShift = other.suffixAt - bPrefix;
    let i = from;
    for (const end = Math.min(aPrefix, bPrefix, n); i < end; i++) {
      const d = this.prefix[i]! - other.prefix[i]!;
      if (d !== 0) return d;
    }
    // Where only the longer prefix still runs.
    const a = aPrefix > bPrefix ? this.prefix : this.block;
    const b = bPrefix > aPrefix ? other.prefix : other.block;
    const aAt = aPrefix > bPrefix ? 0 : aShift;
    const bAt = bPrefix > aPrefix ? 0 : bShift;
    for (const end = Math.min(Math.max(aPrefix, bPrefix), n); i < end; i++) {
      const d = a[aAt + i]! - b[bAt + i]!;
      if (d !== 0) return d;
    }
    for (; i < n; i++) {
      const d = this.block[aShift + i]! - other.block[bShift + i]!;
      if (d !== 0) return d;
    }
    return aLength - bLength;
  }
}

/**
 * Where a version's bytes are. A memtable row lends its own key and value, so
 * a read copies both to hand them out. A record of a run is a `BlockEntry`.
 */
export type LayerEntry =
  | (MemRow & { readonly block?: undefined })
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

/** A put's key as a read hands it out: a copy, as `copyOut` makes one. */
export function keyOf(e: LayerEntry): Uint8Array {
  return e.block ? e.key : copyOut(e.key);
}

/** Copies, as `Db.get` hands them out: one of 65 bytes to 1 KiB, key or value, is a view of a shared buffer. */
export type Entry = { readonly key: Uint8Array; readonly value: Uint8Array };

/** A put as a read hands it out: copies of its key and its value. */
export function entryOf(e: LayerEntry): Entry {
  return { key: keyOf(e), value: copyOut(valueOf(e)) };
}

export type ScanBounds = {
  readonly start?: Uint8Array | undefined;
  readonly endExclusive?: Uint8Array | undefined;
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

/**
 * The first of the sorted `entries` whose key is not below `key`. Every entry
 * between two bounds shares with `key` the bytes both bounds share with it,
 * so a compare starts past them: keys with a long common prefix cost one
 * pass over it, not one per step.
 */
export function lowerBoundKeys(
  entries: readonly { readonly key: Uint8Array }[],
  key: Uint8Array,
): number {
  let lo = 0;
  let hi = entries.length;
  /** Bytes `key` shares with the entry below `lo`, and with the one at `hi`. */
  let below = 0;
  let above = 0;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const k = entries[mid]!.key;
    const n = Math.min(k.length, key.length);
    let i = below < above ? below : above;
    while (i < n && k[i] === key[i]) i++;
    if (i < n ? k[i]! < key[i]! : k.length < key.length) {
      lo = mid + 1;
      below = i;
    } else {
      hi = mid;
      above = i;
    }
  }
  return lo;
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
  /** `unfiltered` is true when a run reads a key's block before its Bloom filter is resident, so the run has not said whether it may hold the key. */
  constructor(
    readonly ready: Promise<readonly Fill[]>,
    readonly unfiltered = false,
  ) {}
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

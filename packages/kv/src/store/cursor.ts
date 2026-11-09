import { compareBytes, containsAll } from "../bytes.js";

export type LayerEntry = {
  readonly key: Uint8Array;
  readonly kind: "put" | "del";
  /** Present iff kind === "put". */
  readonly value?: Uint8Array;
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
      const e = entries[i];
      if (!e) return undefined;
      if (e.kind === "put" && e.value) {
        return { key: e.key, kind: "put", value: e.value };
      }
      return { key: e.key, kind: "del" };
    },
    next() {
      i += step;
    },
  };
}

/**
 * Bytes a sync read needs and does not have yet. The read has already
 * started; once `ready` resolves, the same call hits. A value rather than
 * an exception, so a merge holding several sources keeps their positions.
 */
export class Miss {
  constructor(readonly ready: Promise<void>) {}
}

export type Maybe<T> = T | Miss;

/** One Miss that is ready when all of `misses` are. */
export function allMissed(misses: readonly Miss[]): Miss {
  return misses.length === 1 ? misses[0]! : new Miss(Promise.all(misses.map((m) => m.ready)).then(() => undefined));
}

/** The puts of `cursor` whose value holds every pattern. */
export function filterCursor(cursor: LayerCursor, patterns: readonly Uint8Array[]): LayerCursor {
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
 * Re-runs a sync read until it stops missing. Terminates because the
 * bytes a Miss fills stay pinned until the retry touches them.
 */
export async function settle<T>(attempt: () => Maybe<T>): Promise<T> {
  for (;;) {
    const r = attempt();
    if (!(r instanceof Miss)) return r;
    await r.ready;
  }
}

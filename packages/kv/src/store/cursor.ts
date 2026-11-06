import { compareBytes } from "../bytes.js";

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

/** In-order cursor. `peek` is idempotent. `next` drops the peeked entry. */
export interface LayerCursor {
  peek(): LayerEntry | undefined;
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

export function entryCursor(
  entries: readonly LayerEntry[],
  bounds?: ScanBounds,
): LayerCursor {
  let i = bounds?.start ? lowerBoundKeys(entries, bounds.start) : 0;
  return {
    peek() {
      const e = entries[i];
      if (!e) return undefined;
      if (
        bounds?.endExclusive &&
        compareBytes(e.key, bounds.endExclusive) >= 0
      ) {
        return undefined;
      }
      if (e.kind === "put" && e.value) {
        return { key: e.key, kind: "put", value: e.value };
      }
      return { key: e.key, kind: "del" };
    },
    next() {
      i += 1;
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

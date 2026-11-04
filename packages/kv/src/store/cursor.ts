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

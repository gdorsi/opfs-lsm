import type { Anchor } from "./backend.ts";
import type { ListWindow } from "./query.ts";

/** Rows the list asks for at a time. */
export const LIST_WINDOW = 100;
/** Rows past its anchor that the list's live query may hold before the list anchors again. */
const REACH = 1000;
/** Rows an anchor sits above the first row asked for, so a short scroll up stays in the same live query. */
const ABOVE = 200;

/**
 * Where the list's live query starts and the window in it. Without an anchor the query starts at the top of the
 * order; with one it starts at the anchor's sort value, `base` rows down the list. Windows up to `reach` rows into it
 * move it in place.
 *
 * TanStack loads a window at offset N as the first N rows plus the window, so a window deep in a list the backend
 * can anchor gets its own live query that starts at the sort value of a row above it (`locate`).
 */
export type Placement = { readonly anchor?: Anchor; readonly offset: number; readonly limit: number; readonly reach: number };

export const TOP: Placement = { offset: 0, limit: LIST_WINDOW, reach: REACH };

/** The next placement, or the row whose anchor `locate` must find first. */
export type Step =
  | { readonly kind: "placed"; readonly placement: Placement }
  | { readonly kind: "locate"; readonly row: number; readonly start: number; readonly limit: number };

const at = (anchor: Anchor | undefined, offset: number, limit: number): Placement => ({ anchor, offset, limit, reach: offset + REACH });

/** `placement` with its window moved, the same object when it does not move. */
function moved(placement: Placement, offset: number, limit: number): Placement {
  const reach = Math.max(placement.reach, offset + REACH);
  if (placement.offset === offset && placement.limit === limit && placement.reach === reach) return placement;
  return { ...placement, offset, limit, reach };
}

/**
 * Where rows `from` to `to` of the list are read. `canAnchor`: the backend can anchor this list. `base`: the rows
 * counted before the current anchor.
 */
export function place(placement: Placement, from: number, to: number, { canAnchor, base }: { canAnchor: boolean; base: number }): Step {
  const start = Math.max(0, from);
  const limit = Math.max(LIST_WINDOW, to - from);
  if (!canAnchor || start < REACH) return { kind: "placed", placement: placement.anchor ? at(undefined, start, limit) : moved(placement, start, limit) };
  if (placement.anchor && start >= base && start - base <= placement.reach) return { kind: "placed", placement: moved(placement, start - base, limit) };
  return { kind: "locate", row: start - ABOVE, start, limit };
}

/** The placement once `locate` found the anchor of a step, or found the list shorter. */
export function located(placement: Placement, step: Extract<Step, { kind: "locate" }>, found: Anchor | undefined): Placement {
  if (!found) return at(undefined, step.start, step.limit);
  if (placement.anchor?.value === found.value) return moved(placement, step.start - found.base, step.limit);
  return at(found, step.start - found.base, step.limit);
}

export const windowOf = (placement: Placement): ListWindow => ({ from: placement.anchor?.value, offset: placement.offset, limit: placement.limit });

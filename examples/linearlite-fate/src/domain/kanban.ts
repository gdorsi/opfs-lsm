import { generateKeyBetween } from "fractional-indexing";

/** A `kanbanorder` between two neighbours (null = the column's end). Out-of-order neighbours put it after `before`. */
export function kanbanBetween(before: string | null, after: string | null): string {
  if (before !== null && after !== null && before >= after) return generateKeyBetween(before, null);
  return generateKeyBetween(before, after);
}

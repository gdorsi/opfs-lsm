import { generateKeyBetween } from "fractional-indexing";

/** A `kanbanorder` between two neighbours (null = the column's end). Out-of-order neighbours put it after `before`. */
export function kanbanBetween(before: string | null, after: string | null): string {
  if (before !== null && after !== null && before >= after) return generateKeyBetween(before, null);
  return generateKeyBetween(before, after);
}

/**
 * Whether `order` is a key `kanbanBetween` accepts as a neighbour. The library checks a key's shape but not that
 * its characters are base-62 digits, so that is checked here.
 */
export function isKanbanOrder(order: string): boolean {
  if (!/^[0-9A-Za-z]+$/.test(order)) return false;
  try {
    generateKeyBetween(order, null);
    return true;
  } catch {
    return false;
  }
}

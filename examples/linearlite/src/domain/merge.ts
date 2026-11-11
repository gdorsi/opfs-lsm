import { generateKeyBetween } from "fractional-indexing";
import type { Clocks, Patch, Synced } from "./model.ts";

type Tombstoned = Synced & { readonly deleted?: boolean };

/** Patch the fields, stamp each changed one dirty at `clock`. A field already holding the value is left alone. */
export function applyLocal<T extends Synced>(row: T, patch: Patch<T>, clock: number): T {
  const current = row as Record<string, unknown>;
  const changed = Object.entries(patch as Record<string, unknown>).filter(([f, v]) => v !== undefined && current[f] !== v);
  if (changed.length === 0) return row;
  const dirty: Record<string, number> = { ...row.dirty };
  for (const [f] of changed) dirty[f] = clock;
  return { ...row, ...Object.fromEntries(changed), dirty };
}

/**
 * Fold a server row (a pulled one, or the canonical row of a push result with the `acked` clocks it carries) into
 * the stored one. Returns the row to store, `null` to delete it, `undefined` to leave it as is.
 *
 * A pull never overwrites a dirty field, and a stale or replayed row changes nothing. An ack clears a dirty field
 * only when its clock equals the acked one, so a field edited again while the push was in flight stays dirty.
 */
export function mergeIncoming<T extends Tombstoned>(
  local: T | undefined,
  incoming: Omit<T, "dirty">,
  acked?: Clocks,
): T | null | undefined {
  if (local === undefined) return incoming.deleted ? undefined : (incoming as T);

  const remaining = unacked(local.dirty, acked);
  const cleared = remaining !== local.dirty;
  const newer = incoming.version > local.version;
  if (!newer && !cleared) return undefined;

  const kept: Record<string, unknown> = {};
  for (const f in remaining) kept[f] = (local as Record<string, unknown>)[f];
  const { dirty: _dirty, ...base } = newer ? (incoming as Record<string, unknown>) : (local as Record<string, unknown>);
  const merged = { ...base, ...kept, version: Math.max(incoming.version, local.version) } as unknown as T;
  const result = Object.keys(remaining ?? {}).length > 0 ? ({ ...merged, dirty: remaining } as T) : merged;
  return result.deleted && result.dirty === undefined ? null : result;
}

function unacked(dirty: Clocks | undefined, acked: Clocks | undefined): Clocks | undefined {
  if (dirty === undefined || acked === undefined) return dirty;
  const rest = Object.entries(dirty).filter(([f, clock]) => acked[f] !== clock);
  return rest.length === Object.keys(dirty).length ? dirty : Object.fromEntries(rest);
}

/**
 * A key that sorts between two neighbours. Two clients can drop onto the same slot and mint equal keys, after
 * which a later drop sees `before >= after`; it then goes just after `before`.
 */
export function kanbanBetween(before: string | null, after: string | null): string {
  if (before !== null && after !== null && before >= after) return generateKeyBetween(before, null);
  return generateKeyBetween(before, after);
}

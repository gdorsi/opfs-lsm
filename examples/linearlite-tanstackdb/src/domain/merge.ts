import { generateKeyBetween } from "fractional-indexing";
import type { Clocks, Patch, Synced } from "./model.ts";

type Tombstoned = Synced & { readonly deleted?: boolean };

/** `row` with `dirty` and the `pending` marker, or with neither when `dirty` has no field. */
export function withDirty<T extends Synced>(row: T, dirty: Clocks | undefined): T {
  const { dirty: _dirty, pending: _pending, ...rest } = row as Record<string, unknown>;
  return (dirty !== undefined && Object.keys(dirty).length > 0 ? { ...rest, dirty, pending: true } : rest) as T;
}

export function applyLocal<T extends Synced>(row: T, patch: Patch<T>, clock: number): T {
  const current = row as Record<string, unknown>;
  const changed = Object.entries(patch as Record<string, unknown>).filter(([f, v]) => v !== undefined && current[f] !== v);
  if (changed.length === 0) return row;
  const dirty: Record<string, number> = { ...row.dirty };
  for (const [f] of changed) dirty[f] = clock;
  return withDirty({ ...row, ...Object.fromEntries(changed) }, dirty);
}

export function mergeIncoming<T extends Tombstoned>(
  local: T | undefined,
  incoming: Omit<T, "dirty" | "pending">,
  acked?: Clocks,
): T | null | undefined {
  if (local === undefined) return incoming.deleted ? undefined : (incoming as T);

  const remaining = unacked(local.dirty, acked);
  const cleared = remaining !== local.dirty;
  const newer = incoming.version > local.version;
  if (!newer && !cleared) return undefined;

  const kept: Record<string, unknown> = {};
  for (const f in remaining) kept[f] = (local as Record<string, unknown>)[f];
  const base = newer ? (incoming as Record<string, unknown>) : (local as Record<string, unknown>);
  const result = withDirty({ ...base, ...kept, version: Math.max(incoming.version, local.version) } as unknown as T, remaining);
  return result.deleted && result.dirty === undefined ? null : result;
}

/**
 * `mergeIncoming` for a row of the bodies or comments stream that a pull brought: it joins the replica only when the
 * replica `holds` the issue's thread, so a held body always comes with its comments. A row already stored is merged as ever.
 */
export function mergePulled<T extends Tombstoned>(local: T | undefined, incoming: Omit<T, "dirty" | "pending">, holds: boolean) {
  return local === undefined && !holds ? undefined : mergeIncoming(local, incoming);
}

/**
 * Reset a row to the server's state after the server refused an edit of it. Unlike `mergeIncoming` it takes the
 * server's row whatever its version, since the local version may be ahead of what the server holds, and drops the
 * dirty fields whose clocks are the `refused` ones. A field edited again since the push keeps its value and stays
 * dirty. No server row, or a tombstone, deletes the local one. A row that is no longer stored stays so.
 */
export function restore<T extends Tombstoned>(
  local: T | undefined,
  server: Omit<T, "dirty" | "pending"> | null,
  refused: Clocks,
): T | null | undefined {
  if (local === undefined) return undefined;
  if (server === null || server.deleted) return null;
  const remaining = unacked(local.dirty, refused);
  if (remaining === undefined || Object.keys(remaining).length === 0) return server as T;
  const kept: Record<string, unknown> = {};
  for (const f in remaining) kept[f] = (local as Record<string, unknown>)[f];
  return withDirty({ ...server, ...kept } as unknown as T, remaining);
}

function unacked(dirty: Clocks | undefined, acked: Clocks | undefined): Clocks | undefined {
  if (dirty === undefined || acked === undefined) return dirty;
  const rest = Object.entries(dirty).filter(([f, clock]) => acked[f] !== clock);
  return rest.length === Object.keys(dirty).length ? dirty : Object.fromEntries(rest);
}

export function kanbanBetween(before: string | null, after: string | null): string {
  if (before !== null && after !== null && before >= after) return generateKeyBetween(before, null);
  return generateKeyBetween(before, after);
}

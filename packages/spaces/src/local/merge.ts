/**
 * Merge rules, all pure: no kv, no clock, no crypto. `store.ts` calls them
 * inside a `kv.update` body, so they must stay synchronous.
 *
 * The data model in four rules:
 *   1. A record is a map of cells. Per field, the cell with the larger stamp
 *      wins. Equal stamps are the same write, so either is fine.
 *   2. A tombstone is terminal. A tombstoned record ignores every later
 *      cell, from any stamp. Ids are random, so "delete then recreate" is a
 *      new record and never needs an undelete.
 *   3. Rich-text fields are not cells. Yjs merges them (`richtext.ts`), and
 *      rule 2 applies to them through the tombstone check in their writes.
 *   4. Files are immutable. A file field is an ordinary cell holding a
 *      FileRef.
 *
 * There is no list type and no feed type. A list is a collection with a
 * `position` field (`between()` in ids.ts) and an index ending in it. A
 * feed is a collection of insert-only records with a time field and an
 * index on it. Neither needs a sequence CRDT, because each element is its
 * own record with its own id.
 *
 * Merges commute, associate and are idempotent: a pull applied twice, or
 * a push answered with our own state, writes nothing.
 */

import { keyString } from "../bytes.js";
import type { RecordKeyId } from "../ids.js";
import type { Scalar } from "../schema.js";
import { indexKey } from "./keys.js";
import { UNSET, type Cell, type CellValue, type Json, type RecordState, type Stamp } from "./record.js";
import { encodeTuple } from "./tuple.js";
import type { BoundCollection } from "./store.js";

/** A validated local write for one record: the fields being set. */
export type LocalPatch = ReadonlyMap<string, CellValue>;

/**
 * The cells after a local write. Every patched field gets `stamp`, which
 * `store.ts` drew from `Clock.next(maxStamp(cur, patch.keys()))`.
 * Local values are valid by construction: `db.ts` validated them.
 */
export function applyLocal(cur: RecordState | undefined, coll: string, patch: LocalPatch, stamp: Stamp): RecordState {
  const cells = new Map(cur?.cells);
  for (const [field, value] of patch) cells.set(field, { stamp, value, valid: true });
  return { coll, cells };
}

/** The largest stamp among `fields` in `cur`, the floor for the next local stamp. */
export function maxStamp(cur: RecordState | undefined, fields: Iterable<string>): Stamp | undefined {
  if (cur === undefined) return undefined;
  let max: Stamp | undefined;
  for (const field of fields) {
    const stamp = cur.cells.get(field)?.stamp;
    if (stamp !== undefined && (max === undefined || stamp > max)) max = stamp;
  }
  return max;
}

/** The largest stamp of any cell, the stamp an outbox entry carries. */
export function newestStamp(state: RecordState): Stamp | undefined {
  return maxStamp(state, state.cells.keys());
}

export type MergeOutcome = {
  readonly next: RecordState;
  /** `next` differs from `cur`, or there was no `cur`: write it, diff its index entries. */
  readonly changed: boolean;
  /**
   * `next` holds a cell newer than `incoming` has, so the server's copy is
   * behind and the record stays in the outbox. False means the remote
   * state covers everything here and the outbox entry can go.
   */
  readonly localAhead: boolean;
};

/** Per-field max by stamp. `incoming` cells were validated against this app version's schema before the kv transaction. */
export function mergeRemote(cur: RecordState | undefined, incoming: RecordState): MergeOutcome {
  if (cur === undefined) return { next: incoming, changed: true, localAhead: false };
  let cells: Map<string, Cell> | undefined;
  let localAhead = false;
  for (const [field, theirs] of incoming.cells) {
    const ours = cur.cells.get(field);
    if (ours === undefined || theirs.stamp > ours.stamp) (cells ??= new Map(cur.cells)).set(field, theirs);
    else if (ours.stamp > theirs.stamp) localAhead = true;
  }
  for (const field of cur.cells.keys()) if (!incoming.cells.has(field)) localAhead = true;
  return { next: cells === undefined ? cur : { coll: cur.coll, cells }, changed: cells !== undefined, localAhead };
}

/** Whether every required field of `coll` holds a valid, set cell. A record that is not is stored, merged and synced, but reads and indexes skip it. */
export function isReadable(coll: BoundCollection, state: RecordState): boolean {
  for (const field of coll.fields.values()) {
    if (field.fallback.kind !== "required") continue;
    const cell = state.cells.get(field.name);
    if (cell === undefined || !cell.valid || cell.value === UNSET) return false;
  }
  return true;
}

/**
 * The fields JSON a read returns: valid, set cells, plus the schema's
 * default for each field that has one and no valid, set cell. So a field
 * added with `.default()` in a later app version reads as its default on
 * old records, with no work at read time. Defaults come from
 * `validate(undefined)` at open (`BoundField.fallback`).
 */
export function rowFields(coll: BoundCollection, state: RecordState): { [field: string]: Json } {
  const out: { [field: string]: Json } = {};
  for (const field of coll.fields.values()) {
    const cell = state.cells.get(field.name);
    if (cell !== undefined && cell.valid && cell.value !== UNSET) out[field.name] = cell.value;
    else if (field.fallback.kind === "default") out[field.name] = field.fallback.value;
  }
  return out;
}

/**
 * The index entry keys the record has. A field's value is its valid, set
 * cell, else its default, the value a read shows; a field with neither
 * encodes as null. An unreadable record has none.
 */
export function indexEntries(coll: BoundCollection, id: RecordKeyId, state: RecordState | undefined): Uint8Array[] {
  if (state === undefined || coll.indexes.length === 0 || !isReadable(coll, state)) return [];
  const out: Uint8Array[] = [];
  for (const index of coll.indexes) {
    const values: Scalar[] = [];
    for (const name of index.by) {
      const cell = state.cells.get(name);
      const fallback = coll.fields.get(name)?.fallback;
      values.push(scalarOf(cell) ?? (fallback?.kind === "default" ? (scalarOfValue(fallback.value) ?? null) : null));
    }
    out.push(indexKey(coll.id, index.id, encodeTuple(values), id));
  }
  return out;
}

/** Entries to put and delete to go from `before` to `after`, compared as bytes. */
export function diffEntries(
  before: readonly Uint8Array[],
  after: readonly Uint8Array[],
): { readonly put: Uint8Array[]; readonly del: Uint8Array[] } {
  const had = new Set(before.map(keyString));
  const has = new Set(after.map(keyString));
  return {
    put: after.filter((k) => !had.has(keyString(k))),
    del: before.filter((k) => !has.has(keyString(k))),
  };
}

function scalarOfValue(value: Json): Scalar | undefined {
  return value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number" ? value : undefined;
}

/** Narrowing for index values: what `indexEntries` encodes. */
export function scalarOf(cell: Cell | undefined): Scalar | undefined {
  if (cell === undefined || !cell.valid || cell.value === UNSET) return undefined;
  return scalarOfValue(cell.value);
}

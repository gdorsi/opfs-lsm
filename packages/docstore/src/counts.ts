/**
 * Count indexes: how many documents hold each value tuple of some fields.
 * Each group has a count row, which every write adds its changes to, and a
 * base row, which only the build writes (keys.ts). The count is their sum.
 *
 * Invariant: in every kv state whose catalog has a count index, the count
 * row of a group holds E_now - E_added, where E is the number of documents
 * in the group and "added" is the catalog write that made the index
 * building. From that write on, every write changes rows and count rows in
 * one kv record. The build adds the base row E_added.
 */
import type { Entry, UpdateTx, ViewSnapshot } from "@opfs-lsm/kv";
import { tupleBounds } from "@opfs-lsm/kv/tuple";
import type { IndexPlan } from "./catalog.js";
import { decodeDoc, indexEntries } from "./derive.js";
import { after, bytesEqual, decodeCount, encodeCount, isBaseKey, keyString } from "./keys.js";

type Tally = { readonly key: Uint8Array; n: number };

/** The net change of one transaction's documents, per count row. */
export type CountDeltas = Map<string, Tally>;

function add(rows: CountDeltas, key: Uint8Array, n: number): void {
  const k = keyString(key);
  const row = rows.get(k);
  if (row) row.n += n;
  else rows.set(k, { key, n });
}

/**
 * One document: -1 for each group it was in, +1 for each it is in. Both
 * lists follow the order of the indexes, so a group the document stays in
 * is usually at the same place in both, and costs no map entry.
 */
export function tally(rows: CountDeltas, before: readonly Uint8Array[], after: readonly Uint8Array[]): void {
  if (before.length === after.length) {
    for (let i = 0; i < before.length; i++) {
      if (bytesEqual(before[i], after[i])) continue;
      add(rows, before[i]!, -1);
      add(rows, after[i]!, 1);
    }
    return;
  }
  for (const k of before) add(rows, k, -1);
  for (const k of after) add(rows, k, 1);
}

/** Reads every count row whose group changed, in one `tx.read`, and writes its new value, or deletes it at 0. */
export function applyDeltas(rows: CountDeltas, tx: UpdateTx): void {
  const changed: Tally[] = [];
  for (const row of rows.values()) if (row.n !== 0) changed.push(row);
  if (changed.length === 0) return;
  const values = tx.read(changed.map((r) => r.key));
  for (let i = 0; i < changed.length; i++) {
    const { key, n } = changed[i]!;
    const next = decodeCount(values[i]) + n;
    if (next === 0) tx.delete(key);
    else tx.put(key, encodeCount(next));
  }
}

export type Bases = { readonly bases: readonly Entry[] } | { readonly unindexable: Entry; readonly id: Uint8Array };

/** How long the build reads before it lets the page run. */
const SLICE_MS = 16;

/**
 * The base rows of a building count index, from one snapshot taken after the
 * index was added. For a group, the documents C and the count row D of that
 * snapshot give base = C - D: the documents when the index was added,
 * whichever snapshot it is. So every build, and every rerun of one, writes
 * the same bytes. The documents of a group are spread over the whole id
 * order, so C needs every row of one snapshot. Returns instead a row the
 * index cannot hold, with its id.
 */
export async function readBases(snap: ViewSnapshot, plan: IndexPlan, rowPrefix: Uint8Array): Promise<Bases> {
  const groups = new Map<string, Tally>();
  let slice = performance.now();
  for await (const row of snap.range(tupleBounds(rowPrefix))) {
    const id = row.key.subarray(rowPrefix.length);
    const entries = indexEntries(plan, id, decodeDoc(row.value));
    if (!Array.isArray(entries)) return { unindexable: row, id };
    for (const e of entries) {
      const k = keyString(e.key);
      const g = groups.get(k);
      if (g) g.n++;
      else groups.set(k, { key: e.key, n: 1 });
    }
    if (performance.now() - slice > SLICE_MS) {
      await new Promise((r) => setTimeout(r));
      slice = performance.now();
    }
  }
  const bases: Entry[] = [];
  const { arity, prefix } = plan.target;
  for (const row of await snap.rangeValues(tupleBounds(prefix), decodeCount)) {
    if (isBaseKey(row.key, arity)) continue;
    const k = keyString(row.key);
    const base = (groups.get(k)?.n ?? 0) - row.value;
    groups.delete(k);
    if (base !== 0) bases.push({ key: after(row.key), value: encodeCount(base) });
  }
  for (const g of groups.values()) bases.push({ key: after(g.key), value: encodeCount(g.n) });
  return { bases };
}

/**
 * Count indexes: how many documents hold each value tuple of some fields.
 * Each group has a count row, which every write adds its changes to, and a
 * base row, which only the build writes (keys.ts). The count is their sum.
 *
 * Invariant: in every kv snapshot whose catalog has a count index, its count
 * row of a group holds E_now - E_added, where E is the number of documents
 * in the group and "added" is the catalog write that made the index
 * building. Every write changes rows and count rows in one kv record, from
 * that catalog write on. The build adds the base row E_added.
 */
import type { Entry, Range, UpdateTx, ViewSnapshot } from "@opfs-lsm/kv";
import { tupleBounds } from "@opfs-lsm/kv/tuple";
import type { IndexPlan } from "./catalog.js";
import { decodeDoc, indexEntries } from "./derive.js";
import { baseKey, decodeCount, encodeCount, isBaseKey, keyString } from "./keys.js";

/** The net change of one transaction's documents, per count row. */
export class CountDeltas {
  private readonly rows = new Map<string, { readonly key: Uint8Array; n: number }>();

  /** One document: -1 for each group it was in, +1 for each it is in. */
  tally(before: readonly Uint8Array[], after: readonly Uint8Array[]): void {
    for (const k of before) this.add(k, -1);
    for (const k of after) this.add(k, 1);
  }

  private add(key: Uint8Array, n: number): void {
    const k = keyString(key);
    const row = this.rows.get(k);
    if (row) row.n += n;
    else this.rows.set(k, { key, n });
  }

  /** Reads every count row whose group changed, in one `tx.read`, and writes its new value, or deletes it at 0. */
  apply(tx: UpdateTx): void {
    const changed = [...this.rows.values()].filter((r) => r.n !== 0);
    if (changed.length === 0) return;
    const values = tx.read(changed.map((r) => r.key));
    for (let i = 0; i < changed.length; i++) {
      const { key, n } = changed[i]!;
      const next = decodeCount(values[i]) + n;
      if (next === 0) tx.delete(key);
      else tx.put(key, encodeCount(next));
    }
  }
}

/** The documents counted by the count and base rows in `range`. */
export async function sumCounts(snap: Pick<ViewSnapshot, "range">, range: Range): Promise<number> {
  let n = 0;
  for await (const row of snap.range(range)) n += decodeCount(row.value);
  return n;
}

export type Bases = { readonly bases: readonly Entry[] } | { readonly unindexable: Uint8Array };

/** How long the build reads before it lets the page run. */
const SLICE_MS = 16;

/**
 * The base rows of a building count index, from one snapshot taken after the
 * index was added. For a group g, the documents C and the count row D of that
 * snapshot give base = C - D: the documents when the index was added,
 * whichever snapshot it is. So every build, and every rerun of one, writes
 * the same bytes. The documents of a group are spread over the whole id
 * order, so C needs every row of one snapshot. Returns the id of a row the
 * index cannot hold instead.
 */
export async function readBases(snap: Pick<ViewSnapshot, "range">, plan: IndexPlan, rowPrefix: Uint8Array): Promise<Bases> {
  const groups = new Map<string, { readonly key: Uint8Array; n: number }>();
  let slice = performance.now();
  for await (const row of snap.range(tupleBounds(rowPrefix))) {
    const id = row.key.subarray(rowPrefix.length);
    const entries = indexEntries(plan, id, decodeDoc(row.value));
    if (!Array.isArray(entries)) return { unindexable: id };
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
  for await (const row of snap.range(tupleBounds(prefix))) {
    if (isBaseKey(row.key, arity)) continue;
    const k = keyString(row.key);
    const base = (groups.get(k)?.n ?? 0) - decodeCount(row.value);
    groups.delete(k);
    if (base !== 0) bases.push({ key: baseKey(row.key), value: encodeCount(base) });
  }
  for (const g of groups.values()) bases.push({ key: baseKey(g.key), value: encodeCount(g.n) });
  return { bases };
}

/**
 * App code the tracker contenders share: how a replica folds one batch of
 * the history into its stored rows, and the k-way merge an IN-list needs
 * when the library answers one range per value. The oracle has its own fold:
 * nothing here is imported by bench/datasets.
 */
import type { EntityName, Event, Tx } from "../datasets/tracker/types.ts";

type Row = { readonly id: string };

/** One entity's part of a batch: the rows to write when every event creates, else the ids it touches and their fold. */
export type Change =
  | { readonly kind: "create"; readonly rows: readonly Row[] }
  | {
      readonly kind: "modify";
      /** Distinct ids, in first-touch order. */
      readonly ids: readonly string[];
      /** The rows after the batch, from the stored ones in `ids` order: a row to store, or null to delete. */
      fold(stored: readonly (Row | undefined)[]): (Row | null)[];
    };

/** Per entity, in the order the batch first touches it. */
export function changesOf(tx: Tx): Map<EntityName, Change> {
  const byEntity = new Map<EntityName, Event[]>();
  for (const e of tx.events) {
    const list = byEntity.get(e.entity);
    if (list) list.push(e);
    else byEntity.set(e.entity, [e]);
  }
  const out = new Map<EntityName, Change>();
  for (const [entity, events] of byEntity) {
    if (events.every((e) => e.op === "create")) {
      out.set(entity, { kind: "create", rows: events.map((e) => (e as Event & { op: "create" }).row) });
      continue;
    }
    const ids = [...new Set(events.map((e) => (e.op === "create" ? e.row.id : e.id)))];
    out.set(entity, {
      kind: "modify",
      ids,
      fold(stored) {
        const rows = new Map<string, Row | null>(ids.map((id, i) => [id, stored[i] ?? null]));
        for (const e of events) {
          if (e.op === "create") rows.set(e.row.id, e.row);
          else if (e.op === "delete") rows.set(e.id, null);
          else {
            const row = rows.get(e.id);
            if (!row) throw new Error(`patch of a missing ${entity} ${e.id}`);
            rows.set(e.id, { ...row, ...e.set });
          }
        }
        return ids.map((id) => rows.get(id)!);
      },
    });
  }
  return out;
}

/** The first `limit` rows of several lists that are each already in `order`. */
export function mergeTop<T>(lists: readonly (readonly T[])[], order: (a: T, b: T) => number, limit: number): T[] {
  return lists.flat().sort(order).slice(0, limit);
}

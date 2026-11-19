import { compareBytes, keyToString } from "../bytes.js";
import type { Mark, Marks } from "./marks.js";
import { applyOrder, underDelete, withOp, type MemRow, type WalRecord } from "./memtable.js";
import type { SstEntry } from "./sst.js";

export type Folded = {
  /** The last op per key, in key order, with nothing the chunk's marks cover. */
  readonly entries: SstEntry[];
  /** The chunk's range deletes, joined. */
  readonly marks: Marks;
};

/**
 * Fold a WAL chunk to the last op per key, in key order, under the chunk's
 * own range deletes. It folds each op as a memtable does (`applyOrder`,
 * `withOp`, `underDelete`), so a flushed run and a tab's memtable agree on every row:
 * which op won, and what it says held before the oldest op of its key in
 * the chunk.
 */
export function foldRecords(records: readonly WalRecord[]): Folded {
  const rows = new Map<string, MemRow>();
  const marks: Mark[] = [];
  for (const { seq, ops } of records) {
    for (const op of applyOrder(ops)) {
      if (op.type !== "deleteRange") {
        const id = keyToString(op.key);
        rows.set(id, withOp(rows.get(id), op.key, seq, op.type === "put" ? op.value : undefined, op.was));
        continue;
      }
      for (const [id, row] of rows) {
        const left = underDelete(row, op.start, op.endExclusive, op.through);
        if (left) rows.set(id, left);
        else rows.delete(id);
      }
      if (op.through > 0) marks.push({ ...op, at: seq });
    }
  }
  const entries = [...rows.values()]
    .sort((a, b) => compareBytes(a.key, b.key))
    .map(
      ({ key, seq, kind, value, was }): SstEntry =>
        kind === "put" ? { kind, key, value: value!, seq, was } : { kind, key, seq, was },
    );
  return { entries, marks };
}

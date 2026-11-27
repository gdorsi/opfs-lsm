import { throughAt, type Mark, type Marks } from "./marks.js";
import type { WalRecord } from "./memtable.js";
import type { SstEntry } from "./sst.js";

type Folded = {
  /**
   * The chunk's puts and deletes in the order they were written, without
   * those its marks cover. The run encoder sorts them and keeps the last
   * write of each key.
   */
  readonly entries: SstEntry[];
  /** The chunk's range deletes, joined. */
  readonly marks: Marks;
};

/**
 * Fold a WAL chunk for its L0 run, under the chunk's own range deletes.
 * Dropping covered writes one by one leaves the keys the run must hold: a
 * mark that covers the last write of a key covers every earlier one, whose
 * seqs are no larger, and a key whose last write stays is in the run as that
 * write.
 */
export function foldRecords(records: readonly WalRecord[]): Folded {
  const marks: Mark[] = [];
  for (const rec of records) {
    for (const op of rec.ops) {
      if (op.type === "deleteRange" && op.through > 0) marks.push({ ...op, at: rec.seq });
    }
  }
  const entries: SstEntry[] = [];
  for (const rec of records) {
    for (const op of rec.ops) {
      if (op.type === "deleteRange") continue;
      if (marks.length > 0 && rec.seq <= throughAt(marks, op.key)) continue;
      entries.push(
        op.type === "put"
          ? { kind: "put", key: op.key, value: op.value, seq: rec.seq }
          : { kind: "del", key: op.key, seq: rec.seq },
      );
    }
  }
  return { entries, marks };
}

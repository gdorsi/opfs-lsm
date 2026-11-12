import { compareBytes, keyToString } from "../bytes.js";
import { joinMarks, markCursor, markTable, NO_MARKS, type Marks } from "./marks.js";
import { marksOf, type WalRecord } from "./memtable.js";
import type { SstEntry } from "./sst.js";

export type Folded = {
  /** The last op per key, in key order, with nothing the chunk's marks cover. */
  readonly entries: SstEntry[];
  /** The chunk's range deletes, joined. */
  readonly marks: Marks;
};

/**
 * Fold a WAL chunk to the last op per key, in key order, under the chunk's
 * own range deletes. Filtering the final entries is exact: an entry is
 * covered only by a mark whose `through` reaches its seq, which sits in a
 * later record, and a later write of the key is what the fold kept instead.
 */
export function foldRecords(records: readonly WalRecord[]): Folded {
  const map = new Map<string, SstEntry>();
  let marks = NO_MARKS;
  for (const rec of records) {
    for (const op of rec.ops) {
      if (op.type === "deleteRange") continue;
      map.set(
        keyToString(op.key),
        op.type === "put"
          ? op.expiresAt === undefined
            ? { kind: "put", key: op.key, value: op.value, seq: rec.seq }
            : { kind: "put", key: op.key, value: op.value, seq: rec.seq, expiresAt: op.expiresAt }
          : { kind: "del", key: op.key, seq: rec.seq },
      );
    }
    for (const mark of marksOf(rec)) marks = joinMarks(marks, markTable(mark));
  }
  const entries = [...map.values()].sort((a, b) => compareBytes(a.key, b.key));
  if (marks.empty) return { entries, marks };
  const cursor = markCursor(marks);
  return { entries: entries.filter((e) => e.seq > cursor.at(e.key)), marks };
}

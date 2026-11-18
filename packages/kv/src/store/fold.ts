import type { Marks } from "./marks.js";
import { Memtable, type WalRecord } from "./memtable.js";
import type { SstEntry } from "./sst.js";
import { prevSeq } from "../seq.js";

export type Folded = {
  /** The last op per key, in key order, with nothing the chunk's marks cover. */
  readonly entries: SstEntry[];
  /** The chunk's range deletes, joined. */
  readonly marks: Marks;
};

/**
 * Fold a WAL chunk to the last op per key, in key order, under the chunk's
 * own range deletes. A memtable that holds exactly the chunk is that fold,
 * so a flushed run and a tab's memtable agree on every row: which op won,
 * and what it says held before the oldest op of its key in the chunk.
 */
export function foldRecords(records: readonly WalRecord[]): Folded {
  const mem = new Memtable();
  const first = records[0];
  if (first) mem.advanceTo(prevSeq(first.seq));
  for (const record of records) mem.apply(record);
  const entries = mem.range().map(
    (row): SstEntry =>
      row.kind === "put"
        ? { kind: "put", key: row.key, value: row.value!, seq: row.seq, was: row.was }
        : { kind: "del", key: row.key, seq: row.seq, was: row.was },
  );
  return { entries, marks: mem.marks };
}

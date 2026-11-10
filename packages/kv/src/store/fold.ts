import { compareBytes, keyToString } from "../bytes.js";
import type { WalRecord } from "./memtable.js";
import type { SstEntry } from "./sst.js";

function sortEntries(rows: SstEntry[]): SstEntry[] {
  rows.sort((a, b) => compareBytes(a.key, b.key));
  return rows;
}

/** Fold a WAL tail to the last op per key, in key order. */
export function foldRecords(records: readonly WalRecord[]): SstEntry[] {
  const map = new Map<string, SstEntry>();
  for (const rec of records) {
    for (const op of rec.ops) {
      map.set(
        keyToString(op.key),
        op.type === "put"
          ? { kind: "put", key: op.key, value: op.value, seq: rec.seq }
          : { kind: "del", key: op.key, seq: rec.seq },
      );
    }
  }
  return sortEntries([...map.values()]);
}

import { compareBytes, keyToString } from "../bytes.js";
import type { WalRecord } from "../idb/wal.js";
import type { SstEntry } from "./sst.js";

function sortEntries(rows: SstEntry[]): SstEntry[] {
  rows.sort((a, b) => compareBytes(a.key, b.key));
  return rows;
}

/**
 * One-shot fold of a WAL tail. Last op per key, then key order.
 * The map dies with the call. Ingest encodes the result and drops it.
 */
export function foldRecords(records: readonly WalRecord[]): SstEntry[] {
  const map = new Map<string, SstEntry>();
  for (const rec of records) {
    for (const op of rec.ops) {
      const id = keyToString(op.key);
      if (op.type === "put") {
        map.set(id, { kind: "put", key: op.key, value: op.value });
      } else {
        map.set(id, { kind: "del", key: op.key });
      }
    }
  }
  return sortEntries([...map.values()]);
}

/**
 * One-shot merge for the TypeScript `mergeSsts` fallback.
 * `groups[0]` is the newest run. Oldest is applied first so newer wins.
 */
export function foldEntries(
  groups: readonly (readonly SstEntry[])[],
): SstEntry[] {
  const map = new Map<string, SstEntry>();
  for (let i = groups.length - 1; i >= 0; i--) {
    for (const e of groups[i]!) {
      map.set(keyToString(e.key), e);
    }
  }
  return sortEntries([...map.values()]);
}

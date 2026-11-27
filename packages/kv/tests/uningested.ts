import { readUningested, type IdBWal } from "../src/idb/wal.js";
import type { WalRecord } from "../src/store/memtable.js";

/** The records `readUningested` returns: past ingestedThrough, the oldest that fit in `maxBytes`, and at least one. */
export async function listUningested(wal: IdBWal, limit: { readonly maxBytes: number }): Promise<WalRecord[]> {
  return (await readUningested(wal, limit.maxBytes)).records;
}

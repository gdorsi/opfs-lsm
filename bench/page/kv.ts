/**
 * How every kv-backed contender opens kv: `openDb`, exactly as apps do
 * (SharedWorker host, default ingest policy), never a harness knob. The wasm
 * engine must be live, or L2 runs are not LZ4 and every number is off.
 */
import { engineUsingWasm, ensureEngine, openDb, type Db } from "@opfs-lsm/kv";
import { readStats, settle, type KvStats } from "@opfs-lsm/kv/testing";

export async function openKv(name: string): Promise<Db> {
  const db = await openDb({ name });
  await assertWasm();
  return db;
}

export async function assertWasm(): Promise<void> {
  await ensureEngine();
  if (!engineUsingWasm()) throw new Error("kv wasm engine did not load");
}

/** The engine half of a store: settle, stats, close. */
export function kvCommon(db: Db): { settle(): Promise<void>; stats(): Promise<KvStats>; close(): Promise<void> } {
  return {
    settle: () => settle(db),
    stats: () => readStats(db),
    close: () => db.close(),
  };
}

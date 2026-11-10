/**
 * How every kv-backed contender opens kv: `openDb`, exactly as apps do
 * (SharedWorker host, default ingest policy), never a harness knob. The only
 * option it passes is the public `compactionMemoryBytes`, and only when the
 * run asks for it. The wasm engine must be live, or L2 runs are not LZ4 and
 * every number is off.
 */
import { engineUsingWasm, ensureEngine, openDb, type Db } from "@opfs-lsm/kv";
import { readStats, settle, type KvStats } from "@opfs-lsm/kv/testing";

export async function openKv(name: string): Promise<Db> {
  const db = await openDb({ name, ...compactionMemory() });
  await assertWasm();
  return db;
}

/** `--compaction-memory-bytes` reaches the page as a query parameter, since every run is a fresh Chrome. */
function compactionMemory(): { compactionMemoryBytes?: number } {
  const asked = new URLSearchParams(location.search).get("compactionMemoryBytes");
  return asked ? { compactionMemoryBytes: Number(asked) } : {};
}

async function assertWasm(): Promise<void> {
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

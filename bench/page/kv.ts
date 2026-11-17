/**
 * How every kv-backed contender opens kv: `openDb`, exactly as apps do
 * (SharedWorker host, default ingest policy), never a harness knob. The only
 * option it passes is the public `compactionMemoryBytes`, and only when the
 * run asks for it. `openDb` rejects when the wasm engine does not load, so
 * every run measures LZ4 L2 runs.
 */
import { openDb, type Db } from "@opfs-lsm/kv";
import { readStats, settle, type KvStats } from "@opfs-lsm/kv/testing";

export function openKv(name: string): Promise<Db> {
  return openDb({ name, ...compactionMemory() });
}

/** `--compaction-memory-bytes` reaches the page as a query parameter, since every run is a fresh Chrome. */
function compactionMemory(): { compactionMemoryBytes?: number } {
  const asked = new URLSearchParams(location.search).get("compactionMemoryBytes");
  return asked ? { compactionMemoryBytes: Number(asked) } : {};
}

/** The engine half of a store: settle, stats, close. */
export function kvCommon(db: Db): { settle(): Promise<void>; stats(): Promise<KvStats>; close(): Promise<void> } {
  return {
    settle: () => settle(db),
    stats: () => readStats(db),
    close: () => db.close(),
  };
}

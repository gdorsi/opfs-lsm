/**
 * How every kv-backed contender opens kv: `openDb`, exactly as apps do
 * (SharedWorker host, default ingest policy), never a harness knob. It passes
 * public options only. `reserveBytes: 0`: the default reserve is 24 MiB of
 * written bytes that hold no data, so it would count in the disk bytes and
 * Space-Amp of every run, and its one write would land in a timed phase.
 * `compactionMemoryBytes`, `cacheBytes` and `syncReads`, only when the run
 * asks for them. The page imports `@opfs-lsm/kv/sync-reads` either way, so
 * a run without the flag differs only by the option.
 * `openDb` rejects when the wasm engine does not load, so every run measures
 * the wasm engine.
 */
import { openDb, type Db, type OpenOptions } from "@opfs-lsm/kv";
import { syncReads } from "@opfs-lsm/kv/sync-reads";
import { readStats, settle, type KvStats } from "@opfs-lsm/kv/testing";

export function openKv(name: string): Promise<Db> {
  return openDb({ name, reserveBytes: 0, ...asked() });
}

/** `--compaction-memory-bytes`, `--cache-bytes` and `--sync-reads` reach the page as query parameters, since every run is a fresh Chrome. */
function asked(): Partial<OpenOptions> {
  const query = new URLSearchParams(location.search);
  const bytes = (option: "compactionMemoryBytes" | "cacheBytes") => (query.has(option) ? { [option]: Number(query.get(option)) } : {});
  return { ...bytes("compactionMemoryBytes"), ...bytes("cacheBytes"), ...(query.has("syncReads") ? { syncReads } : {}) };
}

/** The engine half of a store: settle, stats, close. */
export function kvCommon(db: Db): { settle(): Promise<void>; stats(): Promise<KvStats>; close(): Promise<void> } {
  return {
    settle: () => settle(db),
    stats: () => readStats(db),
    close: () => db.close(),
  };
}

/**
 * How every kv-backed contender opens kv: `openDb`, exactly as apps do
 * (SharedWorker host, default ingest policy), never a harness knob. It passes
 * public options only. `reserveBytes: 0`: the default reserve is 24 MiB of
 * written bytes that hold no data, so it would count in the disk bytes and
 * Space-Amp of every run, and its one write would land in a timed phase.
 * `compactionMemoryBytes` and `cacheBytes`, only when the run asks for them.
 * `openDb` rejects when the wasm engine does not load, so every run measures
 * LZ4 L2 runs.
 */
import { openDb, type Db } from "@opfs-lsm/kv";
import { readStats, settle, type KvStats } from "@opfs-lsm/kv/testing";
import type { KvOptions } from "../core/types.ts";

export function openKv(name: string): Promise<Db> {
  return openDb({ name, reserveBytes: 0, ...asked() });
}

/** `--compaction-memory-bytes` and `--cache-bytes` reach the page as query parameters, since every run is a fresh Chrome. */
function asked(): KvOptions {
  const query = new URLSearchParams(location.search);
  const bytes = (option: keyof KvOptions) => (query.has(option) ? { [option]: Number(query.get(option)) } : {});
  return { ...bytes("compactionMemoryBytes"), ...bytes("cacheBytes") };
}

/** The engine half of a store: settle, stats, close. */
export function kvCommon(db: Db): { settle(): Promise<void>; stats(): Promise<KvStats>; close(): Promise<void> } {
  return {
    settle: () => settle(db),
    stats: () => readStats(db),
    close: () => db.close(),
  };
}

import { dbInternals, type Db } from "./db.js";
import type { HostStats } from "./host/protocol.js";
import { watchAppends, type TabWal } from "./idb/wal.js";
import { CountingFs, type IoCounters } from "./opfs/counting-fs.js";

export type { IoCount, IoCounters } from "./opfs/counting-fs.js";

/** Counters are monotonic since the tab Db opened / the host started; callers diff snapshots. */
export type KvStats = {
  tab: {
    /** WAL records this Db handle appended. */
    walAppends: number;
    /** Encoded record bytes handed to IndexedDB, excluding meta puts. */
    walBytes: number;
    /** This tab's OPFS IO (open load, installs). Counted only for a Db that `openHarnessDb` opened. */
    fs?: IoCounters;
  };
  host: HostStats;
};

/** What each tab WAL committed since this module loaded. */
const appended = new WeakMap<TabWal, { records: number; bytes: number }>();
watchAppends((wal, bytes) => {
  const counts = appended.get(wal) ?? { records: 0, bytes: 0 };
  counts.records += 1;
  counts.bytes += bytes;
  appended.set(wal, counts);
});

export async function readStats(db: Db): Promise<KvStats> {
  const { name, wal, fs, ingestClient } = dbInternals(db);
  const host = await ingestClient.stats(name);
  const { records, bytes } = appended.get(wal) ?? { records: 0, bytes: 0 };
  return {
    tab: {
      walAppends: records,
      walBytes: bytes,
      ...(fs instanceof CountingFs ? { fs: structuredClone(fs.counters) } : {}),
    },
    host,
  };
}

/** Flush the memtable now and wait for the compaction it starts. */
export function ingest(db: Db): Promise<{ generation: number }> {
  return dbInternals(db).flush(true);
}

/**
 * Bring background work to rest: ingest until the generation stops changing.
 * One host compaction pass caps its steps, so a cascade can need several.
 */
export async function settle(db: Db): Promise<void> {
  let last = -1;
  for (;;) {
    const { generation } = await ingest(db);
    if (generation === last) return;
    last = generation;
  }
}

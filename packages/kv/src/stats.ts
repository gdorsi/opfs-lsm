import { dbInternals, type Db } from "./db.js";
import type { HostStats } from "./host/protocol.js";
import type { IoCounters } from "./opfs/counting-fs.js";

export type { IoCount, IoCounters } from "./opfs/counting-fs.js";

/** Counters are monotonic since the tab Db opened / the host started; callers diff snapshots. */
export type KvStats = {
  tab: {
    /** WAL records this Db handle appended. */
    walAppends: number;
    /** Encoded record bytes handed to IndexedDB, excluding meta puts. */
    walBytes: number;
    /** This tab's OPFS IO (open load, installs). */
    fs: IoCounters;
  };
  host: HostStats;
};

function internalsOf(db: Db) {
  const found = dbInternals(db);
  if (!found) throw new Error("db was not opened by @opfs-lsm/kv");
  return found;
}

export async function readStats(db: Db): Promise<KvStats> {
  const { name, wal, fs, ingest } = internalsOf(db);
  const host = await ingest.stats(name);
  return {
    tab: {
      walAppends: wal.appendedRecords,
      walBytes: wal.appendedBytes,
      fs: structuredClone(fs.counters),
    },
    host,
  };
}

/** Flush the memtable now and wait for the compaction it starts. */
export function ingest(db: Db): Promise<{ generation: number }> {
  return internalsOf(db).flush();
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

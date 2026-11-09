import { dbInternals, type Db } from "./db.js";
import type { HostStats } from "./host/protocol.js";
import type { IoCounters } from "./opfs/counting-fs.js";

export type { IoCount, IoCounters } from "./opfs/counting-fs.js";

/** Counters are monotonic since the tab Db opened / the host started; callers diff snapshots. */
export type KvStats = {
  tab: {
    /** WAL records this Db handle appended. */
    walAppends: number;
    /** Key and value bytes of the records this Db appended to its log. */
    walBytes: number;
    /** This tab's OPFS IO (open load, installs). */
    fs: IoCounters;
  };
  host: HostStats;
};

function internalsOf(db: Db) {
  const found = dbInternals(db);
  if (!found) throw new Error("readStats: db was not opened by @opfs-lsm/kv");
  return found;
}

export async function readStats(db: Db): Promise<KvStats> {
  const { name, appended, fs, ingest } = internalsOf(db);
  const host = await ingest.stats(name);
  return {
    tab: {
      walAppends: appended.records,
      walBytes: appended.bytes,
      fs: structuredClone(fs.counters),
    },
    host,
  };
}

/**
 * Bring background work to rest: ingest until the generation stops changing.
 * One host compaction pass caps its steps, so a cascade can need several.
 */
export async function settle(db: Db): Promise<void> {
  let last = -1;
  for (;;) {
    const { generation } = await db.ingest();
    if (generation === last) return;
    last = generation;
  }
}

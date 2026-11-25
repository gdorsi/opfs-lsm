import { checkDbName } from "../check.js";
import { ClosedError, StorageUnavailableError } from "../errors.js";
import { forgetDestroyed, readDestroyed } from "../idb/destroyed.js";
import { openExistingWal, recordNew, type IdBWal } from "../idb/wal.js";
import { compactLock, ingestLock, withLock } from "../locks.js";
import type { ReadFs } from "../opfs/async-fs.js";
import { recordEmpty } from "../recover.js";
import { GENERATION_NONE } from "../seq.js";
import { manifestNumbers } from "../store/generation.js";
import { announceGeneration, type IngestClient } from "./protocol.js";

const needsHost = async (): Promise<never> => {
  throw new StorageUnavailableError("needs the SharedWorker");
};

/**
 * The ingest client of a context where the SharedWorker cannot run
 * (design.md, "Where code runs"). Nothing flushes: every record
 * stays in the WAL and the memtable until a host in some context folds it.
 * `destroy` and `repair` write IndexedDB under the host's locks, in its
 * order, so a host running elsewhere never sees half of either.
 */
export function noHost(fs: ReadFs): IngestClient {
  const onWal = (name: string, fn: (wal: IdBWal) => Promise<unknown>) =>
    withLock(ingestLock(name), async () => {
      const wal = await openExistingWal(checkDbName(name));
      if (!wal) throw new ClosedError("database was destroyed");
      try {
        await fn(wal);
      } finally {
        wal.close();
      }
    });
  return {
    ingest: async () => ({ generation: GENERATION_NONE }),
    watch() {},
    unwatch() {},
    makeRoom: async () => {},
    repair: (name) => onWal(name, (wal) => recordBirth(wal, fs)),
    async destroy(name) {
      await withLock(compactLock(name), () => onWal(name, (wal) => recordEmpty(wal, fs, undefined)));
      announceGeneration(name);
    },
    stats: needsHost,
    close() {},
  };
}

/**
 * Rule 0 of recovery where no manifest is on disk. Every other repair pairs
 * the WAL with files a host wrote, and is left to a context with one.
 */
async function recordBirth(wal: IdBWal, fs: ReadFs): Promise<void> {
  const [meta, numbers] = await Promise.all([wal.meta(), manifestNumbers(fs)]);
  if (numbers.length || meta.generation) return needsHost();
  // Recorded already, by the open that won the race to record it.
  if (meta.generation !== undefined) return;
  const known = await readDestroyed(wal.dbName);
  // Under the ingest lock no one else records a birth past the row, so it is still unrecorded.
  if (known) {
    await recordEmpty(wal, fs, known);
    await forgetDestroyed(wal.dbName, known);
  } else {
    await recordNew(wal, meta);
  }
}

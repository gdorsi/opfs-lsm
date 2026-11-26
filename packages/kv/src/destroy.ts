import type { DbName } from "./check.js";
import { CommitError } from "./errors.js";
import { readDestroyed, recordDestroyed } from "./idb/destroyed.js";
import { idbName, idbWal, openDatabase, type IdBWal } from "./idb/wal.js";
import { compactLock, ingestLock, openLock, withLock } from "./locks.js";
import type { RemovableFolder } from "./opfs/async-fs.js";
import { floorOfFiles, recordEmpty } from "./recover.js";

/**
 * Remove database `name` (design.md, "Removing"). Runs in the calling
 * context and starts no SharedWorker. `findFiles` returns the database
 * folder when it exists, and creates nothing. It runs under the locks, so
 * no open can make the folder between the look and the removal.
 *
 * Each step is idempotent, so a call cut off by a crash is finished by the
 * next one:
 * 1. The open lock, then the compaction and ingest locks: no open is half
 *    done, and no flush, merge or install publishes.
 * 2. The fence (`openAlone`): every handle closes, and no earlier
 *    connection can commit any more.
 * 3. `recordEmpty`, the strict commit point. From here the database reads
 *    empty in every state a crash or a power loss can leave.
 * 4. The destroyed row, strict, before anything is removed.
 * 5. The folder.
 * 6. The WAL database, last, so until then it answers any open.
 *
 * With neither store present it returns after step 2 and writes nothing.
 */
export async function removeDatabase(name: DbName, findFiles: () => Promise<RemovableFolder | undefined>): Promise<void> {
  await withLock(openLock(name), () =>
    withLock(compactLock(name), () =>
      withLock(ingestLock(name), async () => {
        const files = await findFiles();
        const wal = await openAlone(name);
        try {
          if (!wal && !files) return;
          const known = await readDestroyed(name);
          const floor = wal ? await recordEmpty(wal, files, known) : await floorOfFiles(files!, known);
          if (floor) await recordDestroyed(name, floor);
          await files?.removeFolder();
          if (wal) await deleteWal(wal);
        } finally {
          wal?.close();
        }
      }),
    ),
  );
}

/**
 * The WAL database as its only connection, or undefined when it does not
 * exist (creates nothing). It opens one version up. IndexedDB first sends
 * `versionchange` to every other connection, and runs the empty upgrade
 * only once each has closed: every handle on the name, in every tab, and
 * any host connection. When it resolves, no write by an earlier connection
 * can commit any more. Waits while a connection does not close.
 */
async function openAlone(name: DbName): Promise<IdBWal | undefined> {
  const probe = await openDatabase(idbName(name), {});
  if (!probe) return undefined;
  const version = probe.version;
  // Our own probe would block the upgrade.
  probe.close();
  const db = await openDatabase(idbName(name), { version: version + 1 });
  return db && idbWal(name, db);
}

/** Close `wal` and delete `opfs-lsm-wal/<name>`. Resolves once it is gone. */
async function deleteWal(wal: IdBWal): Promise<void> {
  wal.close();
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(idbName(wal.dbName));
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new CommitError("deleting the WAL database failed"));
  });
}

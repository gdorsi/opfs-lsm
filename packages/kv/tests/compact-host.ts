import { ClosedError } from "../src/errors.js";
import type { EngineHost } from "../src/host/engine-host.js";
import { unlessHeld } from "../src/host/protocol.js";
import { reconcile } from "../src/recover.js";
import { reclaimManifests } from "../src/store/generation.js";

/**
 * Wait for a fold in flight, reconcile and remove old manifests as a fold
 * that found nothing to fold does, then compact until the levels are in
 * shape. Folds no WAL. Removes no run file here: that needs the compaction
 * lock, and the compaction pass does it under it. It takes the host's turns
 * the way the host's own folds do, so it reads the members the host exposes for it.
 */
export async function compactHost(host: EngineHost, name: string): Promise<void> {
  const db = host["db"](name);
  await db.foldTurn(() =>
    db.exclusive(() =>
      db.withStores(
        async ({ wal, fs }) => {
          const { generation } = await reconcile(wal, fs, db.trusted);
          db.trusted = generation;
          await unlessHeld(name, () => reclaimManifests(fs, generation));
        },
        () => Promise.reject(new ClosedError("database was destroyed")),
      ),
    ),
  );
  await db.compact();
}

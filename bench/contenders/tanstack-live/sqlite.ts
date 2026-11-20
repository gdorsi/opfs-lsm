import {
  createBrowserWASQLitePersistence,
  openBrowserWASQLiteOPFSDatabase,
  persistedCollectionOptions,
} from "@tanstack/browser-db-sqlite-persistence";
import { createCollection } from "@tanstack/db";
import type { LiveStore } from "../../core/families.ts";
import { defineContender } from "../../core/types.ts";
import type { Issue, Label, Project, User } from "../../datasets/tracker/types.ts";
import { createIndexes, holdIds, liveOps, writeHeld, type Collections } from "../../page/tanstack-live.ts";
import { tuneSqlite } from "../tanstack-ondemand/sqlite.ts";

function persisted<T extends { id: string }>(id: string, persistence: ReturnType<typeof createBrowserWASQLitePersistence>) {
  return createCollection(persistedCollectionOptions<T, string>({ id, getKey: (r) => r.id, persistence, schemaVersion: 1, syncMode: "on-demand" }));
}

/** Opens the collections; `relaxed` sets `synchronous=OFF` first, so a commit stays atomic but does not wait for the disk. */
export async function openSqlite(name: string, relaxed: boolean): Promise<LiveStore> {
  const database = await openBrowserWASQLiteOPFSDatabase({ databaseName: `tanstack-live-${name}.sqlite` });
  await tuneSqlite(database, relaxed);
  const persistence = createBrowserWASQLitePersistence({ database });
  const c: Collections = {
    users: persisted<User>("users", persistence),
    projects: persisted<Project>("projects", persistence),
    labels: persisted<Label>("labels", persistence),
    issues: persisted<Issue>("issues", persistence),
  };
  createIndexes(c, { byId: true });
  await Promise.all(Object.values(c).map((col) => col.preload()));
  return {
    ...liveOps(c, writeHeld(c, holdIds(c))),
    settle: async () => {},
    stats: async () => undefined,
    close: async () => {
      await Promise.all(Object.values(c).map((col) => col.cleanup()));
      await database.close?.();
    },
  };
}

export default defineContender({
  family: "tanstack-live",
  durability: "sqlite-full",
  fastPath:
    "persistedCollectionOptions with syncMode on-demand on createBrowserWASQLitePersistence (wa-sqlite, OPFSCoopSyncVFS, in a dedicated WebWorker), a collection per entity; createIndex on the issue fields the screens filter and sort by, and on id, which become SQLite expression indexes; a batch's changes to stored rows first hold those rows with a live query on their ids, then insert, update and delete with an array = one TanStack transaction = one SQLite transaction",
  engine: false,
  open: (name) => openSqlite(name, false),
});

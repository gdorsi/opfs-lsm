import {
  createBrowserWASQLitePersistence,
  openBrowserWASQLiteOPFSDatabase,
  persistedCollectionOptions,
} from "@tanstack/browser-db-sqlite-persistence";
import { BTreeIndex, createCollection } from "@tanstack/db";
import type { OnDemandStore, Todo } from "../../core/families.ts";
import { defineContender } from "../../core/types.ts";
import { onDemandOps } from "../../page/tanstack.ts";

/** Opens the collection with SQLite's default settings. */
async function openSqlite(name: string): Promise<OnDemandStore> {
  const database = await openBrowserWASQLiteOPFSDatabase({ databaseName: `tanstack-${name}.sqlite` });
  const persistence = createBrowserWASQLitePersistence({ database });
  const todos = createCollection(
    persistedCollectionOptions<Todo, string>({
      id: "todos",
      getKey: (t) => t.id,
      persistence,
      schemaVersion: 1,
      syncMode: "on-demand",
    }),
  );
  todos.createIndex((t) => t.owner, { indexType: BTreeIndex });
  todos.createIndex((t) => t.createdAt, { indexType: BTreeIndex });
  // inArray(id, …) reads json_extract(value, '$.id'), not the key column, and scans the table without this index.
  todos.createIndex((t) => t.id, { indexType: BTreeIndex });
  await todos.preload();
  return {
    ...onDemandOps(todos),
    settle: async () => {},
    stats: async () => undefined,
    close: async () => {
      await todos.cleanup();
      await database.close?.();
    },
  };
}

export default defineContender({
  family: "tanstack-ondemand",
  durability: "sqlite-full",
  fastPath:
    "persistedCollectionOptions with syncMode on-demand on createBrowserWASQLitePersistence (wa-sqlite, OPFSCoopSyncVFS, in a dedicated WebWorker, single-tab coordinator); createIndex on owner, createdAt and id, which become SQLite expression indexes (one expression each, so a page by owner sorts that owner's rows); insert/update with an array = one TanStack transaction = one SQLite transaction",
  engine: false,
  open: openSqlite,
});

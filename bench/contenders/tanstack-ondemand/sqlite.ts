import {
  createBrowserWASQLitePersistence,
  openBrowserWASQLiteOPFSDatabase,
  persistedCollectionOptions,
} from "@tanstack/browser-db-sqlite-persistence";
import { BTreeIndex, createCollection } from "@tanstack/db";
import type { OnDemandStore, Todo } from "../../core/families.ts";
import { defineContender } from "../../core/types.ts";
import { onDemandOps } from "../../page/tanstack.ts";

type Database = Awaited<ReturnType<typeof openBrowserWASQLiteOPFSDatabase>>;

const CACHE_KIB = 256 * 1024;

/** Sets the page cache to 256 MiB, as kv's `cacheBytes` default, and with `relaxed` `synchronous=OFF`, so a commit does not wait for the disk. */
export async function tuneSqlite(database: Database, relaxed: boolean): Promise<void> {
  const pragma = async (key: string, value: number) => {
    await database.execute(`PRAGMA ${key} = ${value}`);
    const [row] = await database.execute<Record<string, number>>(`PRAGMA ${key}`);
    if (row?.[key] !== value) throw new Error(`PRAGMA ${key} is ${JSON.stringify(row)}, want ${value}`);
  };
  await pragma("cache_size", -CACHE_KIB);
  if (relaxed) await pragma("synchronous", 0);
}

/** Opens the collection on a database tuned by `tuneSqlite`. */
export async function openSqlite(name: string, relaxed: boolean): Promise<OnDemandStore> {
  const database = await openBrowserWASQLiteOPFSDatabase({ databaseName: `tanstack-${name}.sqlite` });
  await tuneSqlite(database, relaxed);
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
    "persistedCollectionOptions with syncMode on-demand on createBrowserWASQLitePersistence (wa-sqlite, OPFSCoopSyncVFS, in a dedicated WebWorker, single-tab coordinator), PRAGMA cache_size = -262144 (a 256 MiB page cache, as kv's cacheBytes); createIndex on owner, createdAt and id, which become SQLite expression indexes (one expression each, so a page by owner sorts that owner's rows); insert/update with an array = one TanStack transaction = one SQLite transaction",
  engine: false,
  open: (name) => openSqlite(name, false),
});

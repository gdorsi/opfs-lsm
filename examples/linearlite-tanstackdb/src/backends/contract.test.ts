import "fake-indexeddb/auto";
import { openHarnessDb } from "@opfs-lsm/kv/testing";
import { nodeSqlite } from "../testing/sqlite.ts";
import { contract } from "./contract.ts";
import { openIndexedDbBackend } from "./indexeddb.ts";
import { openKvBackend } from "./kv.ts";
import { openSqliteBackend } from "./sqlite.ts";

contract("docstore", async (name) => {
  const db = await openHarnessDb({ name, forceMemory: true });
  const backend = await openKvBackend(db);
  return { backend, close: async () => (await backend.close(), await db.close()) };
});

contract("indexeddb", async (name) => {
  const backend = await openIndexedDbBackend(name);
  return { backend, close: () => backend.close() };
});

contract("sqlite", async (name) => {
  const database = nodeSqlite();
  const backend = await openSqliteBackend(database, { name });
  return { backend, close: async () => (await backend.close(), database.close()) };
});

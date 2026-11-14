import "fake-indexeddb/auto";
import { openHarnessDb } from "@opfs-lsm/kv/testing";
import { contract } from "./contract.ts";
import { openKvBackend } from "./kv.ts";

contract("kv", async (name) => {
  const db = await openHarnessDb({ name, forceMemory: true });
  const backend = await openKvBackend(db);
  return { backend, close: async () => (await backend.close(), await db.close()) };
});

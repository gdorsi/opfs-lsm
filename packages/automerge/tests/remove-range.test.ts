import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { openHarnessDb } from "@opfs-lsm/kv/testing";
import { kvStorage } from "../src/index.ts";

function dbName(): string {
  return `am${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

test("a loadRange running alongside removeRange sees every chunk of the prefix or none", async (t) => {
  const db = await openHarnessDb({ name: dbName(), forceMemory: true });
  const storage = kvStorage(db);
  t.after(() => storage.close?.());
  const count = 200;
  for (let i = 0; i < count; i++) await storage.save(["doc", "incremental", String(i)], Uint8Array.of(i & 0xff));
  await storage.save(["doc", "snapshot", "s"], Uint8Array.of(1));

  let removed = false;
  const removing = storage.removeRange(["doc", "incremental"]).finally(() => (removed = true));
  const seen = new Set<number>();
  while (!removed) {
    seen.add((await storage.loadRange(["doc", "incremental"])).length);
    // The write path waits on macrotasks, which a loop of resolved reads alone would starve.
    await new Promise((resolve) => setImmediate(resolve));
  }
  await removing;

  assert.deepEqual([...seen].filter((n) => n !== 0 && n !== count), []);
  assert.deepEqual(await storage.loadRange(["doc", "incremental"]), []);
  assert.deepEqual(await storage.load(["doc", "snapshot", "s"]), Uint8Array.of(1));
});

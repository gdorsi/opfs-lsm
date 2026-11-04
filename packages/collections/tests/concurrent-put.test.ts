import { afterEach, beforeEach, expect, it } from "vitest";
import {
  ConflictError,
  MemoryFs,
  __resetMemoryFsForTests,
  openDb,
  prefixBound,
  type Db,
} from "@opfs-lsm/kv";
import { CollectionDb, indexPrefix } from "../src/index.js";

const NAME = "collections-concurrent-put";
const schema = {
  tables: [{ name: "users", indexes: [{ name: "email", path: "email" }] }],
};
type User = { id: string; email: string };

function wipe(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${NAME}`);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  __resetMemoryFsForTests(NAME);
  await wipe();
});
afterEach(() => __resetMemoryFsForTests(NAME));

function runAfterFirstRead(kv: Db, hook: () => Promise<unknown>): Db {
  let fired = false;
  const afterRead = async <V>(value: V): Promise<V> => {
    if (!fired) {
      fired = true;
      await hook();
    }
    return value;
  };
  return {
    writerId: kv.writerId,
    get: async (key) => afterRead(await kv.get(key)),
    put: (key, value) => kv.put(key, value),
    delete: (key) => kv.delete(key),
    batch: (build) => kv.batch(build),
    transaction: (body) =>
      kv.transaction((tx) =>
        body({
          get: async (key) => afterRead(await tx.get(key)),
          put: (key, value) => tx.put(key, value),
          delete: (key) => tx.delete(key),
          abort: () => tx.abort(),
        }),
      ),
    range: (range) => kv.range(range),
    view: (body) => kv.view(body),
    changes: (listener) => kv.changes(listener),
    ingest: () => kv.ingest(),
    close: () => kv.close(),
  };
}

it("a put that races another tab's put of the same doc conflicts and leaves one index key", async () => {
  const fs = new MemoryFs();
  const policy = { maxBatches: 10_000, maxDelayMs: 60_000, maxBytes: 1 << 30 };
  const kvA = await openDb({ name: NAME, writerId: "a", fs, forceMemory: true, ingestPolicy: policy });
  const kvB = await openDb({ name: NAME, writerId: "b", fs, forceMemory: true, ingestPolicy: policy });
  const tabB = new CollectionDb(kvB, schema).table<User>("users");
  await tabB.put({ id: "1", email: "old@x.com" });

  const tabA = new CollectionDb(
    runAfterFirstRead(kvA, () => tabB.put({ id: "1", email: "b@x.com" })),
    schema,
  ).table<User>("users");

  await expect(tabA.put({ id: "1", email: "a@x.com" })).rejects.toBeInstanceOf(
    ConflictError,
  );

  const band = prefixBound(indexPrefix("users", "email"));
  const indexKeys: Uint8Array[] = [];
  for await (const e of kvB.range(band)) indexKeys.push(e.key);
  expect(indexKeys).toHaveLength(1);
  expect(await tabB.where("email", "b@x.com")).toEqual([{ id: "1", email: "b@x.com" }]);
  await kvA.close();
  await kvB.close();
});

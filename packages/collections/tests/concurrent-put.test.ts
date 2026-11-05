import { afterEach, beforeEach, expect, it } from "vitest";
import { MemoryFs, __resetMemoryFsForTests, openDb, prefixBound } from "@opfs-lsm/kv";
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

it("racing puts of one doc from two tabs leave exactly one index key, for the final doc", async () => {
  const fs = new MemoryFs();
  const policy = { maxWalBytes: 1 << 30 };
  const kvA = await openDb({ name: NAME, writerId: "a", fs, forceMemory: true, ingestPolicy: policy });
  const kvB = await openDb({ name: NAME, writerId: "b", fs, forceMemory: true, ingestPolicy: policy });
  const tabs = [kvA, kvB].map((kv) => new CollectionDb(kv, schema).table<User>("users"));

  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      tabs[i % 2]!.put({ id: "1", email: `e${i}@x.com` }),
    ),
  );

  await Promise.all([kvA.sync(), kvB.sync()]);
  const final = await tabs[0]!.get("1");
  const keys: Uint8Array[] = [];
  for await (const e of kvA.range(prefixBound(indexPrefix("users", "email")))) {
    keys.push(e.key);
  }
  expect(keys).toHaveLength(1);
  expect(await tabs[1]!.where("email", final!.email)).toEqual([final]);
  await kvA.close();
  await kvB.close();
});

import { afterEach, beforeEach, expect, it } from "vitest";
import { MemoryFs, prefixBound } from "@opfs-lsm/kv";
import { __resetMemoryFsForTests, openHarnessDb } from "@opfs-lsm/kv/testing";
import { CollectionDb, indexPrefix } from "../src/index.js";

const NAME = "collections-concurrent-put";
const schema = {
  tables: [{ name: "users", indexes: [{ name: "email", path: "email" }] }],
};
type User = { id: string; email: string };

beforeEach(() => __resetMemoryFsForTests(NAME));
afterEach(() => __resetMemoryFsForTests(NAME));

/**
 * Two tabs: each tab's update reads its own view, and across tabs the last
 * ingested write wins (kv `Db.update`), so racing puts of one doc from two
 * tabs can leave the index key each tab wrote. One tab's puts go one after
 * another and leave exactly one.
 */
it("racing puts of one doc from one tab's two handles of a table leave exactly one index key, for the final doc", async () => {
  const fs = new MemoryFs();
  const kvA = await openHarnessDb({ name: NAME, fs });
  const kvB = kvA;
  const tabs = [kvA, kvB].map((kv) => new CollectionDb(kv, schema).table<User>("users"));

  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      tabs[i % 2]!.put({ id: "1", email: `e${i}@x.com` }),
    ),
  );

  await kvA.sync();
  const final = await tabs[0]!.get("1");
  const keys: Uint8Array[] = [];
  for await (const e of kvA.range(prefixBound(indexPrefix("users", "email")))) {
    keys.push(e.key);
  }
  expect(keys).toHaveLength(1);
  expect(await tabs[1]!.where("email", final!.email)).toEqual([final]);
  await kvA.close();
});

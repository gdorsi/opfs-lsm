import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, test } from "node:test";
import { collection, defineSchema, DocStoreError, openDocStore } from "@opfs-lsm/docstore";
import type { Db } from "@opfs-lsm/kv";
import { openHarnessDb } from "@opfs-lsm/kv/testing";
import { createCollection, createLiveQueryCollection, eq } from "@tanstack/db";
import { docstoreCollectionOptions } from "../src/index.ts";

type User = { id: string; email: string; name: string };

const schema = defineSchema({
  version: 1,
  collections: {
    users: collection<User>().unique("byEmail", "email").index("byName", "name"),
  },
});

const opened: Db[] = [];
const cleanups: { cleanup(): Promise<void> }[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c.cleanup();
  for (const db of opened.splice(0)) await db.close();
});

async function open(name = `tsdb${randomUUID().slice(0, 8)}`) {
  const kv = await openHarnessDb({ name, forceMemory: true, maxWalBytes: 1 << 30 });
  opened.push(kv);
  return { kv, store: await openDocStore(kv, schema), name };
}

const tracked = <C extends { cleanup(): Promise<void> }>(c: C): C => (cleanups.push(c), c);

for (const syncMode of ["eager", "on-demand"] as const) {
  test(`${syncMode}: a row written through TanStack is stored without TanStack's virtual properties`, async () => {
    const { store } = await open();
    const users = store.collection("users");
    const c = tracked(createCollection(docstoreCollectionOptions({ collection: users, syncMode })));
    const q = tracked(createLiveQueryCollection((q) => q.from({ u: c }).where(({ u }) => eq(u.name, "ada"))));
    await q.preload();
    await c.insert({ id: "u1", email: "a@x", name: "ada" }).when("settled");
    await c.update("u1", (d) => {
      d.email = "b@x";
    }).when("settled");
    assert.deepEqual(await users.get("u1"), { id: "u1", email: "b@x", name: "ada" });
  });

  test(`${syncMode}: a write docstore rejects fails its transaction with the DocStoreError and rolls the row back`, async () => {
    const { store } = await open();
    const users = store.collection("users");
    await users.put({ id: "u1", email: "a@x", name: "ada" });
    const c = tracked(createCollection(docstoreCollectionOptions({ collection: users, syncMode })));
    const q = tracked(createLiveQueryCollection((q) => q.from({ u: c }).where(({ u }) => eq(u.name, "bob"))));
    await q.preload();

    const tx = c.insert({ id: "u2", email: "a@x", name: "bob" });
    await assert.rejects(tx.when("settled"), (err: unknown) => err instanceof DocStoreError && err.code === "unique");
    assert.equal(c.has("u2"), false, "the optimistic row is rolled back");
    assert.equal(q.size, 0);
    assert.equal(await users.get("u2"), undefined);

    await c.insert({ id: "u3", email: "c@x", name: "bob" }).when("settled");
    assert.deepEqual(q.toArray.map((r) => r.id), ["u3"], "the collection keeps working after the rejected write");
  });

  test(`${syncMode}: a collection cleaned up and started again reloads and follows other tabs' writes`, async () => {
    const a = await open();
    const b = await open(a.name);
    const writer = b.store.collection("users");
    await writer.put({ id: "u1", email: "a@x", name: "ada" });
    await a.kv.sync();
    const c = tracked(createCollection(docstoreCollectionOptions({ collection: a.store.collection("users"), syncMode })));
    const live = () => tracked(createLiveQueryCollection((q) => q.from({ u: c }).where(({ u }) => eq(u.name, "ada"))));
    const first = live();
    await first.preload();
    assert.equal(first.size, 1);
    await first.cleanup();
    await c.cleanup();

    await writer.put({ id: "u2", email: "b@x", name: "ada" });
    await a.kv.sync();
    const second = live();
    await second.preload();
    assert.deepEqual(second.toArray.map((r) => r.id).sort(), ["u1", "u2"]);

    await writer.put({ id: "u3", email: "c@x", name: "ada" });
    await writer.delete("u1");
    await a.kv.sync();
    for (let i = 0; i < 100 && second.size !== 2; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(second.toArray.map((r) => r.id).sort(), ["u2", "u3"]);
  });
}

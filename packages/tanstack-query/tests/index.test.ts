import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { hashKey, QueryClient, type QueryKey } from "@tanstack/query-core";
import { ConstraintError, type Db } from "@opfs-lsm/kv";
import { openHarnessDb } from "@opfs-lsm/kv/testing";
import { createQueryPersister } from "../src/index.ts";

type Persister = ReturnType<typeof createQueryPersister>;

function dbName(): string {
  return `tq${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withDb(body: (db: Db) => Promise<void>): Promise<void> {
  const db = await openHarnessDb({ name: dbName(), forceMemory: true });
  try {
    await body(db);
  } finally {
    await db.close();
  }
}

// An infinite gcTime schedules no timer, so a test leaves no handle open.
const newClient = () => new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });

async function persist(persister: Persister, entries: [QueryKey, unknown][]): Promise<void> {
  const client = newClient();
  for (const [queryKey, data] of entries) {
    client.setQueryData(queryKey, data);
    await persister.persistQueryByKey(queryKey, client);
  }
}

async function restored(persister: Persister): Promise<QueryClient> {
  const client = newClient();
  await persister.restoreQueries(client);
  return client;
}

const restoredKeys = async (persister: Persister) =>
  (await restored(persister))
    .getQueryCache()
    .getAll()
    .map((query) => query.queryKey);

// persisterFn writes after the query resolves, on a later task.
async function persisted(persister: Persister, queryKey: QueryKey): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if ((await persister.retrieveQuery(hashKey(queryKey))) !== undefined) return;
    await sleep(5);
  }
  assert.fail(`${JSON.stringify(queryKey)} was never persisted`);
}

test("a query persisted by persisterFn restores in a fresh client without calling queryFn", () =>
  withDb(async (db) => {
    const persister = createQueryPersister(db, { refetchOnRestore: false });
    const queryKey = ["todo", 1];
    const first = await newClient().fetchQuery({
      queryKey,
      queryFn: () => ({ id: 1, title: "write tests" }),
      persister: persister.persisterFn,
    });
    await persisted(persister, queryKey);

    let calls = 0;
    const second = await newClient().fetchQuery({
      queryKey,
      queryFn: () => {
        calls++;
        return { id: 1, title: "from the network" };
      },
      persister: persister.persisterFn,
    });
    assert.deepEqual(second, first);
    assert.equal(calls, 0);
  }));

test("restoreQueries and removeQueries act on the matching persisted queries", () =>
  withDb(async (db) => {
    const persister = createQueryPersister(db);
    await persist(persister, [
      [["todos", 1], "first"],
      [["todos", 2], "second"],
      [["users"], "ada"],
    ]);

    const client = newClient();
    await persister.restoreQueries(client, { queryKey: ["todos"] });
    assert.equal(client.getQueryData(["todos", 1]), "first");
    assert.equal(client.getQueryData(["todos", 2]), "second");
    assert.equal(client.getQueryData(["users"]), undefined);

    await persister.removeQueries({ queryKey: ["todos"] });
    assert.deepEqual(await restoredKeys(persister), [["users"]]);
    assert.equal(await db.count(), 1);
  }));

test("persisterGc removes busted and unreadable queries and keeps other prefixes", () =>
  withDb(async (db) => {
    const current = createQueryPersister(db, { buster: "v2" });
    const other = createQueryPersister(db, { prefix: "other", buster: "v1" });
    await persist(createQueryPersister(db, { buster: "v1" }), [[["old"], 1]]);
    await persist(createQueryPersister(db, { buster: "v2", serialize: () => "not json" }), [[["garbage"], 2]]);
    await persist(current, [[["current"], 3]]);
    await persist(other, [[["kept"], 4]]);
    assert.equal(await db.count(), 4);

    await current.persisterGc();
    assert.equal(await db.count(), 2);
    assert.deepEqual(await restoredKeys(current), [["current"]]);
    assert.deepEqual(await restoredKeys(other), [["kept"]]);
  }));

test("two persisters on one db see each other's writes and removals", () =>
  withDb(async (db) => {
    const first = createQueryPersister(db);
    const second = createQueryPersister(db);
    await persist(first, [[["k"], "from first"]]);
    assert.equal(await second.retrieveQuery(hashKey(["k"])), "from first");
    await persist(second, [[["j"], "from second"]]);
    assert.deepEqual(await restoredKeys(first), [["j"], ["k"]]);
    await second.removeQueries({ queryKey: ["k"] });
    assert.equal(await first.retrieveQuery(hashKey(["k"])), undefined);
  }));

test("unicode query keys, data and prefixes come back unchanged", () =>
  withDb(async (db) => {
    const persister = createQueryPersister(db, { prefix: "ключ/🔑" });
    const entries: [QueryKey, unknown][] = [
      [[""], "empty key"],
      [["ключ/🔑"], "değer 🌍"],
      [["﻿bom"], "﻿value"],
      [["nul\u0000key"], "nul\u0000value"],
      [["lone \ud800 surrogate"], "lone \udc00 surrogate"],
      [["empty value"], ""],
    ];
    await persist(persister, entries);
    const client = await restored(persister);
    for (const [queryKey, data] of entries) assert.equal(client.getQueryData(queryKey), data);
  }));

test("a serialized query or a prefix with a lone surrogate rejects and writes nothing", () =>
  withDb(async (db) => {
    await assert.rejects(
      persist(createQueryPersister(db, { serialize: () => "\ud800" }), [[["k"], 1]]),
      /lone surrogate/,
    );
    await assert.rejects(persist(createQueryPersister(db, { prefix: "\udfff" }), [[["k"], 1]]), /lone surrogate/);
    assert.equal(await db.count(), 0);
  }));

test("a query whose serialized entry is over the kv batch limit rejects with ConstraintError", () =>
  withDb(async (db) => {
    const persister = createQueryPersister(db);
    await assert.rejects(persist(persister, [[["big"], "x".repeat(9 * 1024 * 1024)]]), ConstraintError);
    assert.equal(await persister.retrieveQuery(hashKey(["big"])), undefined);
    assert.equal(await db.count(), 0);
  }));

// persisterFn awaits retrieveQuery before it calls queryFn, so a rejection there fails the query.
test("a query whose storage key is over 8 KiB is never found, and persisting it rejects with ConstraintError", () =>
  withDb(async (db) => {
    const persister = createQueryPersister(db);
    const queryKey = ["search", "x".repeat(9 * 1024)];
    assert.equal(await persister.retrieveQuery(hashKey(queryKey)), undefined);
    const client = newClient();
    client.setQueryData(queryKey, "data");
    await assert.rejects(persister.persistQueryByKey(queryKey, client), ConstraintError);
    assert.equal(await persister.retrieveQuery(hashKey(queryKey)), undefined);
    assert.equal(await db.count(), 0);
  }));

test("kv entries outside the persister's namespace are not restored or collected", () =>
  withDb(async (db) => {
    const persister = createQueryPersister(db);
    const foreign = new TextEncoder().encode(
      JSON.stringify({ buster: "", queryHash: '["foreign"]', queryKey: ["foreign"], state: { data: 1, dataUpdatedAt: Date.now() } }),
    );
    const key = new TextEncoder().encode('tanstack-query-["foreign"]');
    for (const first of [0x00, 0x66, 0x70, 0x72, 0xff]) await db.put(Uint8Array.of(first, ...key), foreign);
    await persist(persister, [[["own"], 2]]);

    assert.deepEqual(await restoredKeys(persister), [["own"]]);
    await createQueryPersister(db, { buster: "other" }).persisterGc();
    assert.equal(await db.count(), 5);
  }));

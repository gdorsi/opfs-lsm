import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { QueryClient, type QueryKey } from "@tanstack/query-core";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import {
  experimental_createQueryPersister,
  persistQueryClientRestore,
  persistQueryClientSave,
} from "@tanstack/query-persist-client-core";
import { ConstraintError, type Db } from "@opfs-lsm/kv";
import { openHarnessDb } from "@opfs-lsm/kv/testing";
import { kvStorage } from "../src/index.ts";

type Storage = ReturnType<typeof kvStorage>;

function dbName(): string {
  return `tq${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withDb(body: (db: Db, storage: Storage) => Promise<void>): Promise<void> {
  const db = await openHarnessDb({ name: dbName(), forceMemory: true });
  try {
    await body(db, kvStorage(db));
  } finally {
    await db.close();
  }
}

// An infinite gcTime schedules no timer, so a test leaves no handle open.
const newClient = () => new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });

const storageKey = (queryKey: QueryKey) => `tanstack-query-${JSON.stringify(queryKey)}`;

// persisterFn writes after the query resolves, on a later task.
async function persisted(storage: Storage, key: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if ((await storage.getItem(key)) != null) return;
    await sleep(5);
  }
  assert.fail(`${key} was never persisted`);
}

const keys = async (storage: Storage) => (await storage.entries()).map(([key]) => key);

test("setItem, getItem and removeItem round-trip, and a missing key reads null", () =>
  withDb(async (_db, storage) => {
    await storage.setItem("k", '{"a":1}');
    assert.equal(await storage.getItem("k"), '{"a":1}');
    await storage.setItem("k", "replaced");
    assert.equal(await storage.getItem("k"), "replaced");
    await storage.removeItem("k");
    assert.equal(await storage.getItem("k"), null);
    assert.equal(await storage.getItem("missing"), null);
    await storage.removeItem("missing");
  }));

test("unicode keys and values come back unchanged", () =>
  withDb(async (_db, storage) => {
    const pairs: [string, string][] = [
      ["", "empty key"],
      ["ключ/🔑", "değer 🌍"],
      ["﻿bom", "﻿value"],
      ["nul\u0000key", "nul\u0000value"],
      ["empty value", ""],
    ];
    for (const [key, value] of pairs) await storage.setItem(key, value);
    for (const [key, value] of pairs) assert.equal(await storage.getItem(key), value);
    assert.deepEqual(new Map(await storage.entries()), new Map(pairs));
  }));

test("entries returns only this package's items", () =>
  withDb(async (db, storage) => {
    await storage.setItem("b", "2");
    await storage.setItem("a", "1");
    for (const first of [0x00, 0x66, 0x70, 0x72, 0xff]) await db.put(Uint8Array.of(first, 0x61), Uint8Array.of(0x78));
    assert.deepEqual(await storage.entries(), [
      ["a", "1"],
      ["b", "2"],
    ]);
  }));

test("a lone surrogate in a key or a value rejects and writes nothing", () =>
  withDb(async (_db, storage) => {
    await assert.rejects(storage.setItem("\ud800", "v"), /lone surrogate/);
    await assert.rejects(storage.setItem("k", "\udc00x"), /lone surrogate/);
    await assert.rejects(storage.getItem("a\ud800"), /lone surrogate/);
    await assert.rejects(storage.removeItem("\udfff"), /lone surrogate/);
    assert.deepEqual(await storage.entries(), []);
  }));

test("an item over the kv batch limit rejects with ConstraintError", () =>
  withDb(async (_db, storage) => {
    await assert.rejects(storage.setItem("big", "x".repeat(9 * 1024 * 1024)), ConstraintError);
    assert.equal(await storage.getItem("big"), null);
  }));

test("two kvStorage instances on one db see each other's writes", () =>
  withDb(async (db, storage) => {
    const other = kvStorage(db);
    await storage.setItem("k", "from first");
    assert.equal(await other.getItem("k"), "from first");
    await other.setItem("j", "from second");
    assert.deepEqual(await keys(storage), ["j", "k"]);
    await other.removeItem("k");
    assert.equal(await storage.getItem("k"), null);
  }));

test("createAsyncStoragePersister saves a client and restores it into a fresh one", () =>
  withDb(async (_db, storage) => {
    const persister = createAsyncStoragePersister({ storage, throttleTime: 0 });
    const source = newClient();
    source.setQueryData(["todos"], [{ id: 1, title: "ship ✓" }]);
    source.setQueryData(["user", 7], { name: "Ada" });
    await persistQueryClientSave({ queryClient: source, persister });

    const restored = newClient();
    await persistQueryClientRestore({ queryClient: restored, persister });
    assert.deepEqual(restored.getQueryData(["todos"]), [{ id: 1, title: "ship ✓" }]);
    assert.deepEqual(restored.getQueryData(["user", 7]), { name: "Ada" });

    await persister.removeClient();
    const empty = newClient();
    await persistQueryClientRestore({ queryClient: empty, persister });
    assert.equal(empty.getQueryData(["todos"]), undefined);
  }));

test("a query persisted by persisterFn restores in a fresh client without calling queryFn", () =>
  withDb(async (_db, storage) => {
    const persister = experimental_createQueryPersister({ storage, refetchOnRestore: false });
    const queryKey = ["todo", 1];
    const first = await newClient().fetchQuery({
      queryKey,
      queryFn: () => ({ id: 1, title: "write tests" }),
      persister: persister.persisterFn,
    });
    await persisted(storage, storageKey(queryKey));

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
  withDb(async (_db, storage) => {
    const persister = experimental_createQueryPersister({ storage });
    const source = newClient();
    for (const queryKey of [["todos", 1], ["todos", 2], ["users"]]) {
      source.setQueryData(queryKey, { queryKey });
      await persister.persistQueryByKey(queryKey, source);
    }

    const restored = newClient();
    await persister.restoreQueries(restored, { queryKey: ["todos"] });
    assert.deepEqual(restored.getQueryData(["todos", 1]), { queryKey: ["todos", 1] });
    assert.deepEqual(restored.getQueryData(["todos", 2]), { queryKey: ["todos", 2] });
    assert.equal(restored.getQueryData(["users"]), undefined);

    await persister.removeQueries({ queryKey: ["todos"] });
    assert.deepEqual(await keys(storage), [storageKey(["users"])]);
  }));

test("persisterGc removes busted and unreadable queries and keeps other items", () =>
  withDb(async (_db, storage) => {
    const old = experimental_createQueryPersister({ storage, buster: "v1" });
    const current = experimental_createQueryPersister({ storage, buster: "v2" });
    const client = newClient();
    client.setQueryData(["old"], 1);
    client.setQueryData(["current"], 2);
    await old.persistQueryByKey(["old"], client);
    await current.persistQueryByKey(["current"], client);
    await storage.setItem("tanstack-query-garbage", "not json");
    await storage.setItem("REACT_QUERY_OFFLINE_CACHE", "{}");

    await current.persisterGc();
    assert.deepEqual(await keys(storage), ["REACT_QUERY_OFFLINE_CACHE", storageKey(["current"])]);
  }));

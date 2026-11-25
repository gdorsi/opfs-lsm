import assert from "node:assert/strict";
import { test } from "node:test";
import { collection, defineSchema, DocStoreError, openDocStore } from "@opfs-lsm/docstore";
import { noStorage, openDb } from "@opfs-lsm/kv";
import { createCollection, createLiveQueryCollection, createTransaction, eq, type Collection } from "@tanstack/db";
import { docstoreCollectionOptions } from "../src/index.ts";

type Todo = { id: string; title: string; done: boolean };
type List = { id: string; name: string };

const schema = defineSchema({ version: 1, collections: { todos: collection<Todo>(), lists: collection<List>() } });

const kv = await openDb({ name: "tanstack-db-no-store" }).catch(noStorage);
const store = kv && (await openDocStore(kv, schema));

const todoOptions = (syncMode: "eager" | "on-demand" = "eager") =>
  docstoreCollectionOptions({ id: "todos", collection: store?.collection("todos"), syncMode });

const openTodos = (c: Collection<Todo, string, any>) =>
  createLiveQueryCollection((q) => q.from({ t: c }).where(({ t }) => eq(t.done, false)));

const plain = (rows: readonly object[]) =>
  rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith("$"))));

const documentError = (err: unknown) => err instanceof DocStoreError && err.code === "document";

test("the open gives no store in Node", () => {
  assert.equal(store, undefined);
});

for (const syncMode of ["eager", "on-demand"] as const) {
  test(`${syncMode}: inserts, updates and deletes show in the collection once persisted`, async () => {
    const todos = createCollection(todoOptions(syncMode));
    const open = openTodos(todos);
    await open.preload();
    assert.equal(todos.status, "ready");
    assert.deepEqual(open.toArray, []);

    await todos.insert({ id: "1", title: "Buy milk", done: false }).when("settled");
    assert.deepEqual(plain(open.toArray), [{ id: "1", title: "Buy milk", done: false }]);
    await todos.update("1", (d) => {
      d.done = true;
    }).when("settled");
    assert.deepEqual(plain(todos.toArray), [{ id: "1", title: "Buy milk", done: true }]);
    assert.deepEqual(open.toArray, []);
    await todos.delete("1").when("settled");
    assert.deepEqual(todos.toArray, []);
    await Promise.all([open.cleanup(), todos.cleanup()]);
  });

  test(`${syncMode}: a collection cleaned up and started again shows the rows it had`, async () => {
    const todos = createCollection(todoOptions(syncMode));
    const first = openTodos(todos);
    await first.preload();
    await todos.insert([
      { id: "1", title: "Buy milk", done: false },
      { id: "2", title: "Walk dog", done: true },
    ]).when("settled");
    await first.cleanup();
    await todos.cleanup();
    assert.equal(todos.size, 0);

    const second = openTodos(todos);
    await second.preload();
    assert.deepEqual(plain(second.toArray), [{ id: "1", title: "Buy milk", done: false }]);
    assert.deepEqual(plain(todos.toArray).map((r) => r["id"]).sort(), ["1", "2"]);
    await Promise.all([second.cleanup(), todos.cleanup()]);
  });
}

test("transact passes the rows in the order of ids, stores, deletes on null and leaves on undefined", async () => {
  const todos = createCollection(todoOptions());
  await todos.preload();
  const milk = { id: "1", title: "Buy milk", done: false };
  const dog = { id: "2", title: "Walk dog", done: false };
  await todos.insert([milk, dog]).when("settled");

  let seen: readonly (Todo | undefined)[] = [];
  await todos.utils.transact(["2", "3", "1"], (docs) => {
    seen = docs;
    return [{ ...dog, done: true }, undefined, null];
  });
  assert.deepEqual(plain(seen.map((d) => d ?? {})), [dog, {}, milk]);
  assert.deepEqual(plain(todos.toArray), [{ ...dog, done: true }]);
  assert.equal(todos.has("3"), false);
  await todos.cleanup();
});

test("transact rejects with DocStoreError and writes nothing on a wrong length or a document under another id", async () => {
  const todos = createCollection(todoOptions());
  await todos.preload();
  const milk = { id: "1", title: "Buy milk", done: false };
  await todos.insert(milk).when("settled");

  await assert.rejects(
    todos.utils.transact(["1"], ([d]) => [{ ...d!, done: true }, null]),
    documentError,
  );
  await assert.rejects(
    todos.utils.transact(["1", "2"], ([d]) => [{ ...d!, done: true }, { id: "3", title: "Elsewhere", done: false }]),
    documentError,
  );
  assert.deepEqual(plain(todos.toArray), [milk]);
  await todos.cleanup();
});

test("acceptMutations confirms a manual transaction across collections of two options objects", async () => {
  const todos = createCollection(todoOptions());
  const lists = createCollection(docstoreCollectionOptions({ id: "lists", collection: store?.collection("lists") }));
  await Promise.all([todos.preload(), lists.preload()]);

  const tx = createTransaction({
    mutationFn: async ({ transaction }) => {
      await todos.utils.acceptMutations(transaction);
      await lists.utils.acceptMutations(transaction);
    },
  });
  tx.mutate(() => {
    todos.insert({ id: "t1", title: "Buy milk", done: false });
    lists.insert({ id: "l1", name: "Errands" });
  });
  await tx.when("settled");
  assert.deepEqual(plain(todos.toArray), [{ id: "t1", title: "Buy milk", done: false }]);
  assert.deepEqual(plain(lists.toArray), [{ id: "l1", name: "Errands" }]);
  await Promise.all([todos.cleanup(), lists.cleanup()]);
});

test("two collections from one options object show each other's writes, and other options do not", async () => {
  const options = todoOptions();
  const a = createCollection(options);
  const b = createCollection(options);
  const other = createCollection(todoOptions());
  await Promise.all([a.preload(), b.preload(), other.preload()]);

  await a.insert({ id: "1", title: "Buy milk", done: false }).when("settled");
  assert.deepEqual(plain(b.toArray), [{ id: "1", title: "Buy milk", done: false }]);
  await b.update("1", (d) => {
    d.done = true;
  }).when("settled");
  assert.deepEqual(plain(a.toArray), [{ id: "1", title: "Buy milk", done: true }]);
  assert.deepEqual(other.toArray, []);
  await Promise.all([a.cleanup(), b.cleanup(), other.cleanup()]);
});

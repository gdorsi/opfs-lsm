import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, test } from "node:test";
import {
  defineSchema,
  DocStoreError,
  openDocStore,
  type Collection,
  type CollectionChange,
  type CollectionSnapshot,
  type JsonDoc,
} from "@opfs-lsm/docstore";
import type { ChangeEvent, Db } from "@opfs-lsm/kv";
import { ingest, openHarnessDb } from "@opfs-lsm/kv/testing";
import {
  collectionOptions,
  createCollection,
  createLiveQueryCollection,
  createTransaction,
  DbClient,
  eq,
  IR,
  type LoadSubsetOptions,
} from "@tanstack/db";
import { docstoreCollectionOptions } from "../src/index.ts";

type Todo = { id: string; title: string };
type Body = { id: string; description: string };
type Comment = { id: string; issue_id: string; body: string };
type Issue = { id: string; modified: number };

const schema = defineSchema<{ todo: Todo; todos: Todo; bodies: Body; comments: Comment; issues: Issue }>()({
  version: 1,
  collections: {
    todo: {},
    todos: {},
    bodies: {},
    comments: { byIssue: { on: "issue_id" } },
    issues: { byModified: { on: "modified" } },
  },
});

type Store = Awaited<ReturnType<typeof openDocStore<typeof schema>>>;

const opened: Db[] = [];
const collections: { cleanup(): Promise<void> }[] = [];

afterEach(async () => {
  for (const c of collections.splice(0).reverse()) await c.cleanup();
  for (const db of opened.splice(0)) await db.close();
});

function dbName(): string {
  return `tsdb${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

async function open(name: string): Promise<{ kv: Db; store: Store }> {
  const kv = await openHarnessDb({ name, forceMemory: true, maxWalBytes: 1 << 30 });
  opened.push(kv);
  return { kv, store: await openDocStore(kv, schema) };
}

async function openWithoutBus(name: string) {
  const g = globalThis as { BroadcastChannel?: unknown };
  const real = g.BroadcastChannel;
  g.BroadcastChannel = undefined;
  try {
    return await open(name);
  } finally {
    g.BroadcastChannel = real;
  }
}

function tracked<C extends { cleanup(): Promise<void> }>(c: C): C {
  collections.push(c);
  return c;
}

const eager = <T extends JsonDoc>(docs: Collection<T, any>) => tracked(createCollection(docstoreCollectionOptions({ collection: docs })));
const todos = (docs: Collection<Todo, any>) => eager(docs);
const onDemand = <T extends JsonDoc>(docs: Collection<T, any>) =>
  tracked(createCollection(docstoreCollectionOptions({ collection: docs, syncMode: "on-demand" })));

type Watchable = {
  subscribeChanges(callback: () => void, options: { includeInitialState: true }): { unsubscribe(): void };
};

/**
 * Resolves once `done()` holds, checked after every change the collection
 * publishes. The subscription starts with the current rows because TanStack
 * does not tell a subscription about a key it never sent it, such as a delete.
 */
function until(collection: Watchable, done: () => boolean, what: string): Promise<void> {
  const settled = Promise.withResolvers<void>();
  const timer = setTimeout(() => settled.reject(new Error(`timed out waiting for ${what}`)), 5000);
  const check = () => {
    if (done()) settled.resolve();
  };
  const sub = collection.subscribeChanges(check, { includeInitialState: true });
  check();
  return settled.promise.finally(() => {
    clearTimeout(timer);
    sub.unsubscribe();
  });
}

const plain = <T extends object>(rows: readonly T[]) =>
  rows
    .map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => !k.startsWith("$"))))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

/** `docs` whose next views each wait, after taking their snapshot, until `open()`. */
function gatedView<T extends JsonDoc>(docs: Collection<T, any>) {
  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const gated = new Proxy(docs, {
    get(target, prop) {
      if (prop === "view") {
        return <R>(body: (snap: CollectionSnapshot<T, any>) => Promise<R>) =>
          target.view(async (snap) => {
            reached.resolve();
            await gate.promise;
            return body(snap);
          });
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { docs: gated, reached: reached.promise, open: () => gate.resolve() };
}

/** `docs` whose change feed can drop appends and be sent events. */
function tappedFeed<T extends JsonDoc>(docs: Collection<T, any>) {
  const listeners = new Set<(event: CollectionChange<T>) => void>();
  let hide = 0;
  const tapped = new Proxy(docs, {
    get(target, prop) {
      if (prop === "changes") {
        return (listener: (event: CollectionChange<T>) => void) => {
          listeners.add(listener);
          const off = target.changes((event) => {
            if (event.kind === "append" && hide > 0) hide--;
            else listener(event);
          });
          return () => {
            listeners.delete(listener);
            off();
          };
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    docs: tapped,
    hideNextAppend: () => hide++,
    emit: (event: CollectionChange<T>) => {
      for (const listener of listeners) listener(event);
    },
  };
}

test("rows persist across a reopen", async () => {
  const name = dbName();
  const first = await open(name);
  const c = todos(first.store.collection("todos"));
  await c.preload();
  await c.insert([
    { id: "1", title: "one" },
    { id: "2", title: "two" },
    { id: "3", title: "three" },
  ]).when("settled");
  await c.update("2", (d) => {
    d.title = "TWO";
  }).when("settled");
  await c.delete("3").when("settled");
  await c.cleanup();
  await first.kv.close();

  const again = todos((await open(name)).store.collection("todos"));
  await again.preload();
  assert.deepEqual(plain(again.toArray), [
    { id: "1", title: "one" },
    { id: "2", title: "TWO" },
  ]);
});

test("an insert, update and delete in one tab reach the other", async () => {
  const name = dbName();
  const [a, b] = [todos((await open(name)).store.collection("todos")), todos((await open(name)).store.collection("todos"))];
  await Promise.all([a.preload(), b.preload()]);

  await a.insert({ id: "7", title: "x" }).when("settled");
  await until(b, () => b.get("7")?.title === "x", "the insert in b");
  await a.update("7", (d) => {
    d.title = "y";
  }).when("settled");
  await until(b, () => b.get("7")?.title === "y", "the update in b");
  await b.delete("7").when("settled");
  await until(a, () => !a.has("7"), "the delete in a");

  assert.equal(a.size, 0);
  assert.equal(b.size, 0);
});

test("an own insert appears once, and its confirmation only clears $hasPendingWrites", async () => {
  const { kv, store } = await open(dbName());
  const c = todos(store.collection("todos"));
  await c.preload();
  const seen: { type: string; key: unknown; title: unknown; pending: unknown }[] = [];
  c.subscribeChanges((changes) => {
    for (const ch of changes) seen.push({ type: ch.type, key: ch.key, title: ch.value.title, pending: ch.value.$hasPendingWrites });
  });

  await c.insert({ id: "1", title: "milk" }).when("settled");
  await kv.sync();

  assert.deepEqual(seen, [
    { type: "insert", key: "1", title: "milk", pending: true },
    { type: "update", key: "1", title: "milk", pending: false },
  ]);
  assert.equal(c.get("1")?.$hasPendingWrites, false);
});

test("a write that lands while the first load reads is not lost", async () => {
  const name = dbName();
  const writer = todos((await open(name)).store.collection("todos"));
  await writer.preload();
  await writer.insert({ id: "before", title: "before" }).when("settled");

  const b = await open(name);
  const gate = gatedView(b.store.collection("todos"));
  const reader = todos(gate.docs);
  const loaded = reader.preload();
  await gate.reached;

  await writer.insert({ id: "during", title: "during" }).when("settled");
  await b.kv.sync();
  gate.open();
  await loaded;

  assert.deepEqual(plain(reader.toArray), [
    { id: "before", title: "before" },
    { id: "during", title: "during" },
  ]);
});

test("an own insert during the first load stays visible until the load confirms it", async () => {
  const { kv, store } = await open(dbName());
  const gate = gatedView(store.collection("todos"));
  const c = todos(gate.docs);
  const loaded = c.preload();
  await gate.reached;
  const written = Promise.withResolvers<void>();
  kv.changes((e) => {
    if (e.kind === "append") written.resolve();
  });

  const tx = c.insert({ id: "mine", title: "early" });
  await written.promise;
  gate.open();
  await tx.when("settled");

  assert.equal(c.has("mine"), true);
  await loaded;
  assert.deepEqual(plain(c.toArray), [{ id: "mine", title: "early" }]);
});

test("a tab that falls behind a flush reloads and matches the writer", async () => {
  const name = dbName();
  const w = await open(name);
  const behind = await openWithoutBus(name);
  const writer = todos(w.store.collection("todos"));
  const reader = todos(behind.store.collection("todos"));
  await writer.preload();
  await writer.insert({ id: "gone", title: "old" }).when("settled");
  await behind.kv.sync();
  await reader.preload();
  assert.equal(reader.size, 1);

  const kinds: ChangeEvent["kind"][] = [];
  behind.kv.changes((e) => kinds.push(e.kind));
  await writer.delete("gone").when("settled");
  await writer.insert({ id: "kept", title: "folded" }).when("settled");
  await ingest(w.kv);
  await writer.insert({ id: "late", title: "after" }).when("settled");
  await behind.kv.sync();

  await until(reader, () => reader.has("late") && !reader.has("gone"), "the reload after the gap");
  assert.deepEqual(kinds, ["gap", "append"]);
  assert.deepEqual(plain(reader.toArray), plain(writer.toArray));
});

test("a gap after an append the feed never delivered still reloads, as after a repair", async () => {
  const name = dbName();
  const w = await open(name);
  const r = await open(name);
  const tap = tappedFeed(r.store.collection("todos"));
  const writer = todos(w.store.collection("todos"));
  const reader = todos(tap.docs);
  await Promise.all([writer.preload(), reader.preload()]);

  tap.hideNextAppend();
  await writer.insert({ id: "unannounced", title: "folded by a repair" }).when("settled");
  await r.kv.sync();
  await writer.insert({ id: "announced", title: "later" }).when("settled");
  await until(reader, () => reader.has("announced"), "the announced row");
  assert.equal(reader.has("unannounced"), false);

  tap.emit({ kind: "gap" });
  await until(reader, () => reader.has("unannounced"), "the reload after the gap");
  assert.deepEqual(plain(reader.toArray), plain(writer.toArray));
});

test("collections named todo and todos stay apart, live and on load", async () => {
  const name = dbName();
  const a = (await open(name)).store;
  const b = (await open(name)).store;
  const [aTodo, aTodos, bTodo, bTodos] = [a.collection("todo"), a.collection("todos"), b.collection("todo"), b.collection("todos")].map(todos);
  await Promise.all([aTodo, aTodos, bTodo, bTodos].map((c) => c!.preload()));

  await aTodo!.insert({ id: "1", title: "from todo" }).when("settled");
  await aTodos!.insert({ id: "1", title: "from todos" }).when("settled");
  await until(bTodos!, () => bTodos!.has("1"), "the todos row in b");
  await until(bTodo!, () => bTodo!.has("1"), "the todo row in b");

  for (const [c, title] of [
    [aTodo, "from todo"],
    [aTodos, "from todos"],
    [bTodo, "from todo"],
    [bTodos, "from todos"],
  ] as const) {
    assert.deepEqual(plain(c!.toArray), [{ id: "1", title }]);
  }
  const reloaded = todos(a.collection("todo"));
  await reloaded.preload();
  assert.deepEqual(plain(reloaded.toArray), [{ id: "1", title: "from todo" }]);
});

test("acceptMutations writes a manual transaction, puts and deletes, as one kv record that arrives as one change batch", async () => {
  const name = dbName();
  const a = await open(name);
  const b = await open(name);
  const writer = todos(a.store.collection("todos"));
  const reader = todos(b.store.collection("todos"));
  await Promise.all([writer.preload(), reader.preload()]);
  await writer.insert({ id: "old", title: "old" }).when("settled");
  await until(reader, () => reader.has("old"), "the first row in b");
  let appends = 0;
  a.kv.changes((e) => {
    if (e.kind === "append") appends++;
  });
  const batches: string[][] = [];
  reader.subscribeChanges((changes) => batches.push(changes.map((ch) => `${ch.type} ${ch.key}`)), { includeInitialState: true });

  const tx = createTransaction({ mutationFn: ({ transaction }) => writer.utils.acceptMutations(transaction) });
  tx.mutate(() => {
    writer.insert({ id: "a", title: "A" });
    writer.insert({ id: "b", title: "B" });
    writer.delete("old");
  });
  await tx.when("settled");
  await until(reader, () => reader.size === 2 && !reader.has("old"), "the transaction in b");

  assert.equal(appends, 1);
  assert.deepEqual(batches, [["insert old"], ["insert a", "insert b", "delete old"]]);
});

test("collections with one name on two dbs each persist only their own rows of a shared transaction", async () => {
  const x = todos((await open(dbName())).store.collection("todos"));
  const y = todos((await open(dbName())).store.collection("todos"));
  await Promise.all([x.preload(), y.preload()]);

  const tx = createTransaction({
    mutationFn: async ({ transaction }) => {
      await x.utils.acceptMutations(transaction);
      await y.utils.acceptMutations(transaction);
    },
  });
  tx.mutate(() => {
    x.insert({ id: "x", title: "in x" });
    y.insert({ id: "y", title: "in y" });
  });
  await tx.when("settled");

  assert.deepEqual(plain(x.toArray), [{ id: "x", title: "in x" }]);
  assert.deepEqual(plain(y.toArray), [{ id: "y", title: "in y" }]);
});

test("the default id names the collection", async () => {
  const { store } = await open(dbName());
  assert.equal(todos(store.collection("todos")).id, "opfs-lsm:todos");
});

test("one options descriptor serves two DbClients, each with its own collection", async () => {
  const { store } = await open(dbName());
  const options = collectionOptions(docstoreCollectionOptions({ collection: store.collection("todos") }));
  const a = tracked(new DbClient().collection(options));
  const b = tracked(new DbClient().collection(options));
  await Promise.all([a.preload(), b.preload()]);
  assert.notEqual(a, b);

  const tx = createTransaction({ mutationFn: ({ transaction }) => a.utils.acceptMutations(transaction) });
  tx.mutate(() => a.insert({ id: "1", title: "from a" }));
  await tx.when("settled");
  await until(b, () => b.has("1"), "the row in the second client");

  assert.deepEqual(plain(b.toArray), [{ id: "1", title: "from a" }]);
});

test("closing the db fails the collection, keeps its rows and rejects later writes", async () => {
  const { kv, store } = await open(dbName());
  const c = todos(store.collection("todos"));
  await c.preload();
  await c.insert({ id: "1", title: "kept" }).when("settled");

  await kv.close();

  assert.ok(c.health.error, "the collection reports the closed db");
  assert.equal(c.status, "ready");
  assert.deepEqual(plain(c.toArray), [{ id: "1", title: "kept" }]);
  const late = c.insert({ id: "2", title: "late" });
  await assert.rejects(late.when("settled"));
  assert.equal(c.has("2"), false);
  assert.equal(c.size, 1);
});

test("transact puts, deletes and leaves rows by what merge returns, and the collection shows it on resolve", async () => {
  const { store } = await open(dbName());
  const c = todos(store.collection("todos"));
  await c.preload();
  await c.insert([
    { id: "a", title: "A" },
    { id: "b", title: "B" },
    { id: "c", title: "C" },
  ]).when("settled");

  let seen: ReadonlyArray<Todo | undefined> = [];
  await c.utils.transact(["a", "b", "c", "d"], (rows) => {
    seen = rows;
    return [{ id: "a", title: `${rows[0]!.title}!` }, null, undefined, { id: "d", title: "D" }];
  });

  assert.deepEqual(seen, [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }, undefined]);
  assert.deepEqual(plain(c.toArray), [
    { id: "a", title: "A!" },
    { id: "c", title: "C" },
    { id: "d", title: "D" },
  ]);
});

test("transact merges against a row another handle wrote after this collection loaded, after a first run on what this tab saw", async () => {
  const name = dbName();
  const writer = todos((await open(name)).store.collection("todos"));
  const reader = todos((await openWithoutBus(name)).store.collection("todos"));
  await Promise.all([writer.preload(), reader.preload()]);
  await writer.insert({ id: "1", title: "from the writer" }).when("settled");
  assert.equal(reader.has("1"), false);

  const seen: (Todo | undefined)[] = [];
  await reader.utils.transact(["1"], ([row]) => {
    seen.push(row);
    return [row && { id: "1", title: `${row.title}, merged` }];
  });

  assert.deepEqual(seen.at(-1), { id: "1", title: "from the writer" });
  assert.deepEqual(plain(reader.toArray), [{ id: "1", title: "from the writer, merged" }]);
});

test("transact writes nothing when merge returns the wrong length, another id or throws", async () => {
  const { kv, store } = await open(dbName());
  const c = todos(store.collection("todos"));
  await c.preload();
  await c.insert({ id: "a", title: "A" }).when("settled");
  const appends: number[] = [];
  kv.changes((e) => {
    if (e.kind === "append") appends.push(e.seq);
  });
  const document = (err: unknown) => err instanceof DocStoreError && err.code === "document";

  await assert.rejects(c.utils.transact(["a", "b"], () => [null]), document);
  await assert.rejects(c.utils.transact(["a", "b"], () => [null, { id: "c", title: "C" }]), document);
  await assert.rejects(
    c.utils.transact(["a"], () => {
      throw new Error("no");
    }),
    /no/,
  );

  assert.deepEqual(appends, []);
  const reloaded = todos(store.collection("todos"));
  await reloaded.preload();
  assert.deepEqual(plain(reloaded.toArray), [{ id: "a", title: "A" }]);
});

test("a transact during the first load resolves once the collection shows the write", async () => {
  const { kv, store } = await open(dbName());
  const gate = gatedView(store.collection("todos"));
  const c = todos(gate.docs);
  const loaded = c.preload();
  await gate.reached;

  const appended = Promise.withResolvers<void>();
  kv.changes((e) => {
    if (e.kind === "append") appended.resolve();
  });

  const written = c.utils.transact(["x"], () => [{ id: "x", title: "X" }]);
  let resolved = false;
  void written.then(() => (resolved = true));
  await appended.promise;
  await new Promise((r) => setImmediate(r));
  assert.equal(resolved, false, "transact waits for the load that will show its write");
  gate.open();
  await written;

  assert.deepEqual(plain(c.toArray), [{ id: "x", title: "X" }]);
  await loaded;
});

const comment = (issue: string, n: number, body = `${issue}${n}`): Comment => ({ id: `${issue}-${n}`, issue_id: issue, body });

function commentsOf(c: ReturnType<typeof onDemand<Comment>>, issue: string) {
  return tracked(createLiveQueryCollection((q) => q.from({ c }).where(({ c }) => eq(c.issue_id, issue))));
}

test("an on-demand collection is ready at once and holds only what a live query loads", async () => {
  const name = dbName();
  await (await open(name)).store.collection("comments").putMany([comment("X", 1), comment("X", 2), comment("Y", 1), comment("XY", 1)]);

  const c = onDemand((await open(name)).store.collection("comments"));
  c.startSyncImmediate();
  assert.equal(c.isReady(), true);
  assert.equal(c.size, 0);

  const ofX = commentsOf(c, "X");
  await ofX.preload();

  assert.deepEqual(plain(ofX.toArray).map((r) => r.id), ["X-1", "X-2"]);
  assert.deepEqual([...c.keys()].sort(), ["X-1", "X-2"]);
});

test("an on-demand collection loads by id", async () => {
  const { store } = await open(dbName());
  const c = onDemand(store.collection("bodies"));
  await c.utils.transact(["A", "B"], () => [
    { id: "A", description: "a" },
    { id: "B", description: "b" },
  ]);
  assert.equal(c.size, 0, "a write no live query asked for stays out of memory");

  const q = tracked(createLiveQueryCollection((q) => q.from({ b: c }).where(({ b }) => eq(b.id, "B"))));
  await q.preload();

  assert.deepEqual(plain(q.toArray), [{ id: "B", description: "b" }]);
  assert.deepEqual([...c.keys()], ["B"]);
  await c.utils.transact(["B"], ([row]) => [{ ...row!, description: "b2" }]);
  assert.equal(c.get("B")?.description, "b2", "a transact on a loaded row shows on resolve");
});

test("another handle's writes reach a loaded subset, and writes outside it stay out of memory", async () => {
  const name = dbName();
  const writer = eager((await open(name)).store.collection("comments"));
  const c = onDemand((await open(name)).store.collection("comments"));
  await writer.preload();
  const ofX = commentsOf(c, "X");
  await ofX.preload();

  await writer.insert(comment("Y", 1)).when("settled");
  await writer.insert(comment("X", 1)).when("settled");
  await until(ofX, () => ofX.size === 1, "the X comment");
  await writer.update("X-1", (d) => {
    d.body = "edited";
  }).when("settled");
  await until(ofX, () => ofX.get("X-1")?.body === "edited", "the edit");
  await writer.delete("X-1").when("settled");
  await until(c, () => !c.has("X-1"), "the delete");

  assert.equal(c.has("Y-1"), false);
  assert.equal(c.size, 0);
});

test("cleaning up a live query unloads its rows, and a row two queries share stays until both go", async () => {
  const { store } = await open(dbName());
  const c = onDemand(store.collection("bodies"));
  await c.utils.transact(["A", "B"], () => [
    { id: "A", description: "a" },
    { id: "B", description: "b" },
  ]);
  const byId = (id: string) => tracked(createLiveQueryCollection((q) => q.from({ b: c }).where(({ b }) => eq(b.id, id))));
  const [first, second, other] = [byId("A"), byId("A"), byId("B")];
  await Promise.all([first.preload(), second.preload(), other.preload()]);
  assert.deepEqual([...c.keys()].sort(), ["A", "B"]);

  await other.cleanup();
  await until(c, () => !c.has("B"), "B to unload");
  await first.cleanup();
  assert.equal(c.has("A"), true, "the second query still holds A");
  await second.cleanup();
  await until(c, () => c.size === 0, "A to unload");

  await c.utils.transact(["A"], () => [{ id: "A", description: "later" }]);
  assert.equal(c.size, 0, "an unloaded row no longer follows writes");
});

test("a write that lands while a subset loads is not lost", async () => {
  const name = dbName();
  const writer = (await open(name)).store.collection("comments");
  await writer.put(comment("X", 1, "old"));

  const r = await open(name);
  const gate = gatedView(r.store.collection("comments"));
  const c = onDemand(gate.docs);
  const ofX = commentsOf(c, "X");
  const loaded = ofX.preload();
  await gate.reached;

  await writer.put(comment("X", 1, "new"));
  await writer.put(comment("X", 2));
  await r.kv.sync();
  gate.open();
  await loaded;

  assert.deepEqual(
    ofX.toArray.map((r) => [r.id, r.body]).sort(),
    [
      ["X-1", "new"],
      ["X-2", "X2"],
    ],
  );
});

test("a gap reloads every loaded subset, its puts and its deletes", async () => {
  const name = dbName();
  const writer = (await open(name)).store.collection("comments");
  const r = await open(name);
  const tap = tappedFeed(r.store.collection("comments"));
  const c = onDemand(tap.docs);
  await writer.put(comment("X", 1));
  await r.kv.sync();
  const ofX = commentsOf(c, "X");
  await ofX.preload();
  assert.equal(ofX.size, 1);

  tap.hideNextAppend();
  await writer.delete("X-1");
  tap.hideNextAppend();
  await writer.put(comment("X", 2));
  await r.kv.sync();
  assert.deepEqual([...c.keys()], ["X-1"]);

  tap.emit({ kind: "gap" });
  await until(c, () => c.has("X-2") && !c.has("X-1"), "the reload after the gap");
});

test("an ordered window holds its page, takes a write that sorts into it and leaves out one that sorts past it", async () => {
  const name = dbName();
  const other = (await open(name)).store.collection("issues");
  await other.putMany(Array.from({ length: 50 }, (_, i) => ({ id: `i${i}`, modified: i })));
  const r = await open(name);
  const c = onDemand(r.store.collection("issues"));
  const top = tracked(
    createLiveQueryCollection((q) =>
      q
        .from({ i: c })
        .orderBy(({ i }) => i.modified, "desc")
        .limit(5),
    ),
  );
  await top.preload();
  assert.deepEqual(top.toArray.map((i) => i.id), ["i49", "i48", "i47", "i46", "i45"]);
  assert.equal(c.size, 5);

  await other.put({ id: "past", modified: 10 });
  await other.put({ id: "into", modified: 100 });
  await until(top, () => top.toArray[0]?.id === "into", "the row that sorts first");
  assert.equal(c.has("past"), false);

  await other.delete("into");
  await other.delete("i49");
  await until(top, () => top.toArray[0]?.id === "i48" && top.size === 5, "the window to refill");
  assert.deepEqual(top.toArray.map((i) => i.id), ["i48", "i47", "i46", "i45", "i44"]);
});

const newest = (c: ReturnType<typeof onDemand<Issue>>, limit: number) =>
  tracked(
    createLiveQueryCollection((q) =>
      q
        .from({ i: c })
        .orderBy(({ i }) => i.modified, "desc")
        .limit(limit),
    ),
  );

test("a row that moves past an ordered window's last row leaves memory, and the window refills", async () => {
  const name = dbName();
  const other = (await open(name)).store.collection("issues");
  await other.putMany(Array.from({ length: 50 }, (_, i) => ({ id: `i${i}`, modified: i })));
  const c = onDemand((await open(name)).store.collection("issues"));
  const top = newest(c, 5);
  await top.preload();

  await other.put({ id: "i49", modified: 0 });
  await until(top, () => top.toArray.at(-1)?.id === "i44", "the window to refill");

  assert.deepEqual(top.toArray.map((i) => i.id), ["i48", "i47", "i46", "i45", "i44"]);
  assert.equal(c.has("i49"), false);
});

test("a window shortened by writes that land while its load is in flight refills once the load settles", async () => {
  const name = dbName();
  const other = (await open(name)).store.collection("issues");
  await other.putMany(Array.from({ length: 5 }, (_, i) => ({ id: `i${i + 1}`, modified: i + 1 })));
  const r = await open(name);
  const gate = gatedView(r.store.collection("issues"));
  const top = newest(onDemand(gate.docs), 3);
  const loaded = top.preload();
  await gate.reached;

  await other.deleteMany(["i5", "i4"]);
  await r.kv.sync();
  gate.open();
  await loaded;

  await until(top, () => top.size === 3, "the window to refill");
  assert.deepEqual(top.toArray.map((i) => i.id), ["i3", "i2", "i1"]);
});

test("loading the same options twice supersedes the first fetch, which then never commits", async () => {
  const name = dbName();
  const writer = (await open(name)).store.collection("bodies");
  await writer.put({ id: "A", description: "old" });

  const r = await open(name);
  const slow = Promise.withResolvers<void>();
  const firstReached = Promise.withResolvers<void>();
  let views = 0;
  const docs = new Proxy(r.store.collection("bodies"), {
    get(target, prop) {
      if (prop === "view") {
        return <R>(body: (snap: CollectionSnapshot<Body, any>) => Promise<R>) => {
          const mine = ++views;
          return target.view(async (snap) => {
            if (mine === 1) {
              firstReached.resolve();
              await slow.promise;
            }
            return body(snap);
          });
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const config = docstoreCollectionOptions({ collection: docs, syncMode: "on-demand" });
  const commits: Body[][] = [];
  let batch: Body[] = [];
  const handle = config.sync.sync({
    collection: undefined as never,
    begin: () => (batch = []),
    write: (m: unknown) => batch.push((m as { value: Body }).value),
    commit: () => void commits.push(batch),
    markReady: () => {},
    truncate: () => {},
    fail: () => {},
    invalidateLoadedSubsets: () => {},
    metadata: undefined as never,
  } as never) as { cleanup(): void; loadSubset(o: LoadSubsetOptions): Promise<void> };

  const options: LoadSubsetOptions = { where: eq(new IR.PropRef(["id"]), "A") };
  const first = handle.loadSubset(options);
  await firstReached.promise;
  await writer.put({ id: "A", description: "new" });
  await r.kv.sync();
  const second = handle.loadSubset(options);
  await second;
  slow.resolve();
  await first;

  assert.deepEqual(
    commits.flat().map((r) => r.description),
    commits.flat().map(() => "new"),
    "the superseded fetch never commits its older snapshot",
  );
  handle.cleanup();
});

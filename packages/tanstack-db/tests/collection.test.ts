import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, test } from "node:test";
import type { ChangeEvent, Db } from "@opfs-lsm/kv";
import { openHarnessDb, ingest } from "@opfs-lsm/kv/testing";
import {
  collectionOptions,
  createCollection,
  createLiveQueryCollection,
  createTransaction,
  DbClient,
  eq,
  parseLoadSubsetOptions,
  type LoadSubsetOptions,
} from "@tanstack/db";
import { kvCollectionOptions } from "../src/index.ts";

type Todo = { id: string; title: string };
type Item = { id: number; title: string };

const opened: Db[] = [];
const collections: { cleanup(): Promise<void> }[] = [];

afterEach(async () => {
  for (const c of collections.splice(0).reverse()) await c.cleanup();
  for (const db of opened.splice(0)) await db.close();
});

function dbName(): string {
  return `tsdb${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

async function open(name: string): Promise<Db> {
  const db = await openHarnessDb({ name, forceMemory: true, maxWalBytes: 1 << 30 });
  opened.push(db);
  return db;
}

async function openWithoutBus(name: string): Promise<Db> {
  const g = globalThis as { BroadcastChannel?: unknown };
  const real = g.BroadcastChannel;
  g.BroadcastChannel = undefined;
  try {
    return await open(name);
  } finally {
    g.BroadcastChannel = real;
  }
}

function todos(db: Db, name = "todos") {
  const c = createCollection(kvCollectionOptions({ db, name, getKey: (t: Todo) => t.id }));
  collections.push(c);
  return c;
}

function items(db: Db) {
  const c = createCollection(kvCollectionOptions({ db, name: "items", getKey: (t: Item) => t.id }));
  collections.push(c);
  return c;
}

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
  rows.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => !k.startsWith("$")))).sort((a, b) =>
    String(a.id).localeCompare(String(b.id)),
  );

test("rows persist across a reopen", async () => {
  const name = dbName();
  const first = await open(name);
  const c = items(first);
  await c.preload();
  await c.insert([
    { id: 1, title: "one" },
    { id: 2, title: "two" },
    { id: 3, title: "three" },
  ]).when("settled");
  await c.update(2, (d) => {
    d.title = "TWO";
  }).when("settled");
  await c.delete(3).when("settled");
  await c.cleanup();
  await first.close();

  const again = items(await open(name));
  await again.preload();
  assert.deepEqual(plain(again.toArray), [
    { id: 1, title: "one" },
    { id: 2, title: "TWO" },
  ]);
});

test("an insert, update and delete in one tab reach the other", async () => {
  const name = dbName();
  const [a, b] = [items(await open(name)), items(await open(name))];
  await Promise.all([a.preload(), b.preload()]);

  await a.insert({ id: 7, title: "x" }).when("settled");
  await until(b, () => b.get(7)?.title === "x", "the insert in b");
  await a.update(7, (d) => {
    d.title = "y";
  }).when("settled");
  await until(b, () => b.get(7)?.title === "y", "the update in b");
  await b.delete(7).when("settled");
  await until(a, () => !a.has(7), "the delete in a");

  assert.equal(a.size, 0);
  assert.equal(b.size, 0);
});

test("an own insert appears once, and its confirmation only clears $hasPendingWrites", async () => {
  const db = await open(dbName());
  const c = todos(db);
  await c.preload();
  const seen: { type: string; key: unknown; title: unknown; pending: unknown }[] = [];
  c.subscribeChanges((changes) => {
    for (const ch of changes) seen.push({ type: ch.type, key: ch.key, title: ch.value.title, pending: ch.value.$hasPendingWrites });
  });

  await c.insert({ id: "1", title: "milk" }).when("settled");
  await db.sync();

  assert.deepEqual(seen, [
    { type: "insert", key: "1", title: "milk", pending: true },
    { type: "update", key: "1", title: "milk", pending: false },
  ]);
  assert.equal(c.get("1")?.$hasPendingWrites, false);
});

function gatedView(db: Db) {
  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const gated = new Proxy(db, {
    get(target, prop) {
      if (prop === "view") {
        return <T>(body: Parameters<Db["view"]>[0]) =>
          target.view(async (snap) => {
            reached.resolve();
            await gate.promise;
            return body(snap) as T;
          });
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: gated, reached: reached.promise, open: () => gate.resolve() };
}

test("a write that lands while the first load reads is not lost", async () => {
  const name = dbName();
  const writer = todos(await open(name));
  await writer.preload();
  await writer.insert({ id: "before", title: "before" }).when("settled");

  const b = await open(name);
  const gate = gatedView(b);
  const reader = todos(gate.db);
  const loaded = reader.preload();
  await gate.reached;

  await writer.insert({ id: "during", title: "during" }).when("settled");
  await b.sync();
  gate.open();
  await loaded;

  assert.deepEqual(plain(reader.toArray), [
    { id: "before", title: "before" },
    { id: "during", title: "during" },
  ]);
});

test("an own insert during the first load stays visible until the load confirms it", async () => {
  const db = await open(dbName());
  const gate = gatedView(db);
  const c = todos(gate.db);
  const loaded = c.preload();
  await gate.reached;
  const written = Promise.withResolvers<void>();
  db.changes((e) => {
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
  const writer = todos(w);
  const reader = todos(behind);
  await writer.preload();
  await writer.insert({ id: "gone", title: "old" }).when("settled");
  await behind.sync();
  await reader.preload();
  assert.equal(reader.size, 1);

  const kinds: ChangeEvent["kind"][] = [];
  behind.changes((e) => kinds.push(e.kind));
  await writer.delete("gone").when("settled");
  await writer.insert({ id: "kept", title: "folded" }).when("settled");
  await ingest(w);
  await writer.insert({ id: "late", title: "after" }).when("settled");
  await behind.sync();

  await until(reader, () => reader.has("late") && !reader.has("gone"), "the reload after the gap");
  assert.deepEqual(kinds, ["gap", "append"]);
  assert.deepEqual(plain(reader.toArray), plain(writer.toArray));
});

/** A db whose change feed the test can thin out and add to. */
function tappedFeed(db: Db) {
  const listeners = new Set<(event: ChangeEvent) => void>();
  let hide = 0;
  const tapped = new Proxy(db, {
    get(target, prop) {
      if (prop === "changes") {
        return (listener: (event: ChangeEvent) => void) => {
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
    db: tapped,
    hideNextAppend: () => hide++,
    emit: (event: ChangeEvent) => {
      for (const listener of listeners) listener(event);
    },
  };
}

test("a gap at a seq already synced still reloads, as after a repair", async () => {
  const name = dbName();
  const w = await open(name);
  const r = await open(name);
  const tap = tappedFeed(r);
  const writer = todos(w);
  const reader = todos(tap.db);
  await Promise.all([writer.preload(), reader.preload()]);

  tap.hideNextAppend();
  await writer.insert({ id: "unannounced", title: "folded by a repair" }).when("settled");
  await r.sync();
  await writer.insert({ id: "announced", title: "later" }).when("settled");
  await until(reader, () => reader.has("announced"), "the announced row");
  assert.equal(reader.has("unannounced"), false);

  tap.emit({ kind: "gap", through: await r.view((snap) => snap.seq) });
  await until(reader, () => reader.has("unannounced"), "the reload after the gap");
  assert.deepEqual(plain(reader.toArray), plain(writer.toArray));
});

test("collections named todo and todos stay apart, live and on load", async () => {
  const name = dbName();
  const a = await open(name);
  const b = await open(name);
  const [aTodo, aTodos, bTodo, bTodos] = [todos(a, "todo"), todos(a, "todos"), todos(b, "todo"), todos(b, "todos")];
  await Promise.all([aTodo, aTodos, bTodo, bTodos].map((c) => c.preload()));

  await aTodo.insert({ id: "1", title: "from todo" }).when("settled");
  await aTodos.insert({ id: "1", title: "from todos" }).when("settled");
  await until(bTodos, () => bTodos.has("1"), "the todos row in b");
  await until(bTodo, () => bTodo.has("1"), "the todo row in b");

  for (const [c, title] of [
    [aTodo, "from todo"],
    [aTodos, "from todos"],
    [bTodo, "from todo"],
    [bTodos, "from todos"],
  ] as const) {
    assert.deepEqual(plain(c.toArray), [{ id: "1", title }]);
  }
  const reloaded = todos(a, "todo");
  await reloaded.preload();
  assert.deepEqual(plain(reloaded.toArray), [{ id: "1", title: "from todo" }]);
});

test("acceptMutations writes a manual transaction as one kv record that arrives as one change batch", async () => {
  const name = dbName();
  const a = await open(name);
  const b = await open(name);
  const writer = todos(a);
  const reader = todos(b);
  await Promise.all([writer.preload(), reader.preload()]);
  const appends: number[] = [];
  a.changes((e) => {
    if (e.kind === "append") appends.push(e.ops.length);
  });
  const batches: string[][] = [];
  reader.subscribeChanges((changes) => batches.push(changes.map((ch) => `${ch.type} ${ch.key}`)));

  const tx = createTransaction({ mutationFn: ({ transaction }) => writer.utils.acceptMutations(transaction) });
  tx.mutate(() => {
    writer.insert({ id: "a", title: "A" });
    writer.insert({ id: "b", title: "B" });
  });
  await tx.when("settled");
  await until(reader, () => reader.size === 2, "both rows in b");

  assert.deepEqual(appends, [2]);
  assert.deepEqual(batches, [["insert a", "insert b"]]);
});

test("collections with one name on two dbs each persist only their own rows of a shared transaction", async () => {
  const x = todos(await open(dbName()));
  const y = todos(await open(dbName()));
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

test("the default id names the db, so one collection name on two dbs gives two ids", async () => {
  const first = dbName();
  const x = todos(await open(first));
  const y = todos(await open(dbName()));

  assert.equal(x.id, `opfs-lsm:${first}:todos`);
  assert.notEqual(x.id, y.id);
});

test("one options descriptor serves two DbClients, each with its own collection", async () => {
  const db = await open(dbName());
  const options = collectionOptions(kvCollectionOptions({ db, name: "todos", getKey: (t: Todo) => t.id }));
  const a = new DbClient().collection(options);
  const b = new DbClient().collection(options);
  collections.push(a, b);
  await Promise.all([a.preload(), b.preload()]);
  assert.notEqual(a, b);

  const tx = createTransaction({ mutationFn: ({ transaction }) => a.utils.acceptMutations(transaction) });
  tx.mutate(() => a.insert({ id: "1", title: "from a" }));
  await tx.when("settled");
  await until(b, () => b.has("1"), "the row in the second client");

  assert.deepEqual(plain(b.toArray), [{ id: "1", title: "from a" }]);
});

test("closing the db fails the collection, keeps its rows and rejects later writes", async () => {
  const db = await open(dbName());
  const c = todos(db);
  await c.preload();
  await c.insert({ id: "1", title: "kept" }).when("settled");

  await db.close();

  assert.ok(c.health.error, "the collection reports the closed db");
  assert.equal(c.status, "ready");
  assert.deepEqual(plain(c.toArray), [{ id: "1", title: "kept" }]);
  const late = c.insert({ id: "2", title: "late" });
  await assert.rejects(late.when("settled"));
  assert.equal(c.has("2"), false);
  assert.equal(c.size, 1);
});

test("transact puts, deletes and leaves rows by what merge returns, and the collection shows it on resolve", async () => {
  const db = await open(dbName());
  const c = todos(db);
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

test("transact merges against a row another handle wrote after this collection loaded", async () => {
  const name = dbName();
  const writer = todos(await open(name));
  const reader = todos(await openWithoutBus(name));
  await Promise.all([writer.preload(), reader.preload()]);
  await writer.insert({ id: "1", title: "from the writer" }).when("settled");
  assert.equal(reader.has("1"), false);

  let seen: Todo | undefined;
  await reader.utils.transact(["1"], ([row]) => {
    seen = row;
    return [{ id: "1", title: `${row!.title}, merged` }];
  });

  assert.deepEqual(seen, { id: "1", title: "from the writer" });
  assert.deepEqual(plain(reader.toArray), [{ id: "1", title: "from the writer, merged" }]);
});

test("transact writes nothing when merge returns the wrong length, a mismatched key or throws", async () => {
  const db = await open(dbName());
  const c = todos(db);
  await c.preload();
  await c.insert({ id: "a", title: "A" }).when("settled");
  const appends: number[] = [];
  db.changes((e) => {
    if (e.kind === "append") appends.push(e.seq);
  });

  await assert.rejects(c.utils.transact(["a", "b"], () => [null]), RangeError);
  await assert.rejects(c.utils.transact(["a", "b"], () => [null, { id: "c", title: "C" }]), TypeError);
  await assert.rejects(
    c.utils.transact(["a"], () => {
      throw new Error("no");
    }),
    /no/,
  );

  assert.deepEqual(appends, []);
  const reloaded = todos(db);
  await reloaded.preload();
  assert.deepEqual(plain(reloaded.toArray), [{ id: "a", title: "A" }]);
});

test("a transact during the first load resolves once the collection shows the write", async () => {
  const db = await open(dbName());
  const gate = gatedView(db);
  const c = todos(gate.db);
  const loaded = c.preload();
  await gate.reached;

  const appended = Promise.withResolvers<void>();
  db.changes((e) => {
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

type Comment = { key: string; issue_id: string; body: string };
type Body = { id: string; description: string };

/** The value a live query's `where` compares `field` to with `eq`. */
function eqValue(options: LoadSubsetOptions, field: string): unknown {
  const filter = parseLoadSubsetOptions(options).filters.find((f) => f.operator === "eq" && f.field.join(".") === field);
  if (!filter) throw new Error(`load ${field} with eq`);
  return filter.value;
}

/** Comments keyed `${issue_id}/${n}`, loaded by issue as one prefix. */
function comments(db: Db) {
  const c = createCollection(
    kvCollectionOptions({
      db,
      name: "comments",
      getKey: (r: Comment) => r.key,
      onDemand: { plan: (options) => ({ prefix: `${String(eqValue(options, "issue_id"))}/` }) },
    }),
  );
  collections.push(c);
  return c;
}

/** Descriptions loaded by id as point gets. */
function bodies(db: Db) {
  const c = createCollection(
    kvCollectionOptions({
      db,
      name: "bodies",
      getKey: (r: Body) => r.id,
      onDemand: { plan: (options) => ({ keys: [String(eqValue(options, "id"))] }) },
    }),
  );
  collections.push(c);
  return c;
}

/** An eager collection on the same rows, as another tab's writer. */
function eagerComments(db: Db) {
  const c = createCollection(kvCollectionOptions({ db, name: "comments", getKey: (r: Comment) => r.key }));
  collections.push(c);
  return c;
}

function commentsOf(c: ReturnType<typeof comments>, issue: string) {
  const q = createLiveQueryCollection((q) => q.from({ c }).where(({ c }) => eq(c.issue_id, issue)));
  collections.push(q);
  return q;
}

const comment = (issue: string, n: number, body = `${issue}${n}`): Comment => ({ key: `${issue}/${n}`, issue_id: issue, body });

test("an on-demand collection is ready at once and holds only what a live query loads by prefix", async () => {
  const name = dbName();
  const writer = eagerComments(await open(name));
  await writer.preload();
  await writer.insert([comment("X", 1), comment("X", 2), comment("Y", 1), comment("XY", 1)]).when("settled");

  const c = comments(await open(name));
  c.startSyncImmediate();
  assert.equal(c.isReady(), true);
  assert.equal(c.size, 0);

  const ofX = commentsOf(c, "X");
  await ofX.preload();

  assert.deepEqual(plain(ofX.toArray).map((r) => r.key), ["X/1", "X/2"]);
  assert.deepEqual([...c.keys()].sort(), ["X/1", "X/2"]);
});

test("an on-demand collection loads by keys", async () => {
  const name = dbName();
  const db = await open(name);
  const c = bodies(db);
  await c.utils.transact(["A", "B"], () => [
    { id: "A", description: "a" },
    { id: "B", description: "b" },
  ]);
  assert.equal(c.size, 0, "a write no plan covers stays out of memory");

  const q = createLiveQueryCollection((q) => q.from({ b: c }).where(({ b }) => eq(b.id, "B")));
  collections.push(q);
  await q.preload();

  assert.deepEqual(plain(q.toArray), [{ id: "B", description: "b" }]);
  assert.deepEqual([...c.keys()], ["B"]);
  await c.utils.transact(["B"], ([row]) => [{ ...row!, description: "b2" }]);
  assert.equal(c.get("B")?.description, "b2", "a transact on a covered key shows on resolve");
});

test("another handle's writes reach a loaded subset, and writes outside it stay out of memory", async () => {
  const name = dbName();
  const writer = eagerComments(await open(name));
  const c = comments(await open(name));
  await writer.preload();
  const ofX = commentsOf(c, "X");
  await ofX.preload();

  await writer.insert(comment("Y", 1)).when("settled");
  await writer.insert(comment("X", 1)).when("settled");
  await until(ofX, () => ofX.size === 1, "the X comment");
  await writer.update("X/1", (d) => {
    d.body = "edited";
  }).when("settled");
  await until(ofX, () => ofX.get("X/1")?.body === "edited", "the edit");
  await writer.delete("X/1").when("settled");
  await until(c, () => !c.has("X/1"), "the delete");

  assert.equal(c.has("Y/1"), false);
  assert.equal(c.size, 0);
});

test("cleaning up a live query unloads its rows, and a row two queries share stays until both go", async () => {
  const name = dbName();
  const db = await open(name);
  const c = bodies(db);
  await c.utils.transact(["A", "B"], () => [
    { id: "A", description: "a" },
    { id: "B", description: "b" },
  ]);
  const byId = (id: string) => {
    const q = createLiveQueryCollection((q) => q.from({ b: c }).where(({ b }) => eq(b.id, id)));
    collections.push(q);
    return q;
  };
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
  assert.equal(c.size, 0, "an unloaded key no longer follows writes");
});

test("a write that lands while a subset loads is not lost", async () => {
  const name = dbName();
  const writer = eagerComments(await open(name));
  await writer.preload();
  await writer.insert(comment("X", 1, "old")).when("settled");

  const r = await open(name);
  const gate = gatedView(r);
  const c = comments(gate.db);
  const ofX = commentsOf(c, "X");
  const loaded = ofX.preload();
  await gate.reached;

  await writer.update("X/1", (d) => {
    d.body = "new";
  }).when("settled");
  await writer.insert(comment("X", 2)).when("settled");
  await r.sync();
  gate.open();
  await loaded;

  assert.deepEqual(
    ofX.toArray.map((r) => [r.key, r.body]).sort(),
    [
      ["X/1", "new"],
      ["X/2", "X2"],
    ],
  );
});

test("a gap reloads every loaded subset, its puts and its deletes", async () => {
  const name = dbName();
  const w = await open(name);
  const r = await open(name);
  const tap = tappedFeed(r);
  const writer = eagerComments(w);
  const c = comments(tap.db);
  await writer.preload();
  await writer.insert(comment("X", 1)).when("settled");
  await r.sync();
  const ofX = commentsOf(c, "X");
  await ofX.preload();
  assert.equal(ofX.size, 1);

  tap.hideNextAppend();
  await writer.delete("X/1").when("settled");
  tap.hideNextAppend();
  await writer.insert(comment("X", 2)).when("settled");
  await r.sync();
  assert.deepEqual([...c.keys()], ["X/1"]);

  tap.emit({ kind: "gap", through: await r.view((snap) => snap.seq) });
  await until(c, () => c.has("X/2") && !c.has("X/1"), "the reload after the gap");
});

test("a plan that throws fails that query's load", async () => {
  const c = comments(await open(dbName()));
  const q = createLiveQueryCollection((q) => q.from({ c }));
  collections.push(q);

  await assert.rejects(q.preload(), /load issue_id with eq/);
});

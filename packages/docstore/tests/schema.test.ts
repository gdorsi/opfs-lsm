import type { Db } from "@opfs-lsm/kv";
import { afterEach, describe, expect, it } from "vitest";
import { collection, defineSchema, openDocStore, type DocStore } from "../src/index.js";
import { encodeCatalog, type StoredCatalog } from "../src/catalog.js";
import { CATALOG_KEY } from "../src/keys.js";
import type { Json, Schema } from "../src/schema.js";
import {
  codeOf,
  docstoreKeys,
  freshName,
  gate,
  keysUnder,
  openKv,
  recording,
  storedCatalog,
  storedPrefix,
  wrap,
  wrapViews,
} from "./harness.js";

type Todo = {
  id: string;
  title?: string | undefined;
  done?: boolean | undefined;
  createdAt?: number | undefined;
  slug?: string | null | undefined;
  label?: Json | undefined;
};
type Labelled = { id: string; createdAt?: number | undefined; label?: string | undefined };
type Tagged = { id: string; tags?: string[] | undefined };

const byCreated = collection<Todo>().index("byCreated", "createdAt");
const base = byCreated.index("byTitle", "title");
const v1 = defineSchema({ version: 1, collections: { todos: base } });
const v2 = defineSchema({ version: 2, collections: { todos: base.index("byDone", ["done", "createdAt"]) } });
const unique = (version: number) => defineSchema({ version, collections: { todos: base.unique("bySlug", "slug") } });
const labelled = defineSchema({
  version: 2,
  collections: { todos: collection<Labelled>().index("byCreated", "createdAt").index("byLabel", "label") },
});
const tagged = defineSchema({ version: 1, collections: { tagged: collection<Tagged>().index("byTag", "tags[]") } });

const kvs: Db[] = [];
const stores: Pick<DocStore<Schema>, "whenIdle">[] = [];
afterEach(async () => {
  await Promise.allSettled(stores.splice(0).map((s) => s.whenIdle()));
  await Promise.all(kvs.splice(0).map((kv) => kv.close()));
});

async function kvOn(name: string): Promise<Db> {
  const kv = await openKv(name);
  kvs.push(kv);
  return kv;
}

async function openOn<S extends Schema>(kv: Db, schema: S): Promise<DocStore<S>> {
  const store = await openDocStore(kv, schema);
  stores.push(store);
  return store;
}

async function at<S extends Schema>(name: string, schema: S) {
  const kv = await kvOn(name);
  return { kv, store: await openOn(kv, schema) };
}

const rows = (n: number, from = 0): Todo[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `r${String(from + i).padStart(4, "0")}`,
    title: `t${i % 7}`,
    done: (from + i) % 3 === 0,
    createdAt: from + i,
  }));

const doneIds = (docs: readonly Todo[]) =>
  docs.filter((d) => d.done === true).sort((a, b) => a.createdAt! - b.createdAt!).map((d) => d.id);

describe("opening a schema", () => {
  it("refuses another definition at the stored version and changes no key", async () => {
    const { kv, store } = await at(freshName(), v1);
    await store.collection("todos").putMany(rows(10));
    const before = await docstoreKeys(kv);
    const other = defineSchema({ version: 1, collections: { todos: byCreated.index("byTitle", "slug") } });
    expect(await codeOf(openDocStore(kv, other))).toBe("schema");
    expect(await docstoreKeys(kv)).toEqual(before);
  });

  it("refuses a stored catalog of another format", async () => {
    const kv = await kvOn(freshName());
    await kv.put(CATALOG_KEY, encodeCatalog({ format: 1 } as unknown as StoredCatalog));
    expect(await codeOf(openDocStore(kv, v1))).toBe("schema");
  });

  it("builds a new index over 3,000 rows before open resolves", async () => {
    const name = freshName();
    const old = await at(name, v1);
    const docs = rows(3_000);
    for (let i = 0; i < docs.length; i += 1_000) await old.store.collection("todos").putMany(docs.slice(i, i + 1_000));
    const { store } = await at(name, v2);
    expect((await store.collection("todos").queryIds({ index: "byDone", eq: [true] })).ids).toEqual(doneIds(docs));
    expect(await store.collection("todos").count({ index: "byDone" })).toBe(3_000);
  });

  it("lets a handle on the old version keep writing, and the new index holds its writes", async () => {
    const name = freshName();
    const old = await at(name, v1);
    const docs = rows(30);
    await old.store.collection("todos").putMany(docs);
    const next = await at(name, v2);
    await old.store.collection("todos").put({ id: "late", done: true, createdAt: 100 });
    await old.store.collection("todos").delete("r0003");
    await next.kv.sync();
    const now = [...docs.filter((d) => d.id !== "r0003"), { id: "late", done: true, createdAt: 100 }];
    expect((await next.store.collection("todos").queryIds({ index: "byDone", eq: [true] })).ids).toEqual(doneIds(now));
  });

  it("moves a put on a handle with no index from the blind plan to the full one once a newer schema adds an index", async () => {
    const name = freshName();
    const bare = defineSchema({ version: 1, collections: { todos: collection<Todo>() } });
    const { db, updates } = recording(await kvOn(name));
    // Deaf to change events, so the old handle learns of the index only when its write reads the catalog.
    const old = await openOn(wrap(db, { changes: () => () => {} }), bare);
    const docs = rows(30);
    await old.collection("todos").putMany(docs);
    const next = await at(name, v2);
    updates.length = 0;
    const late = [
      { ...docs[0]!, done: !docs[0]!.done },
      { ...docs[1]!, done: !docs[1]!.done },
      { id: "late", done: true, createdAt: 100 },
    ];
    await old.collection("todos").putMany(late);
    expect(updates).toEqual([
      { reads: 1, puts: 0, deletes: 0 },
      { reads: 4, puts: expect.any(Number), deletes: expect.any(Number) },
    ]);
    await next.kv.sync();
    const now = [...late, ...docs.slice(2)];
    expect((await next.store.collection("todos").queryIds({ index: "byDone", eq: [true] })).ids).toEqual(doneIds(now));
    expect(await next.store.collection("todos").count({ index: "byDone" })).toBe(now.length);
  });

  it("never returns a document under a redefined index's old definition, and the old handle may not query it", async () => {
    const name = freshName();
    const old = await at(name, v1);
    await old.store.collection("todos").putMany([
      { id: "1", title: "t", createdAt: 1 },
      { id: "2", title: "a", slug: "s", createdAt: 2 },
    ]);
    const oldTitles = await storedPrefix(old.kv, "todos", "byTitle");
    const redefined = defineSchema({ version: 2, collections: { todos: byCreated.index("byTitle", "slug") } });
    const next = await at(name, redefined);
    expect((await next.store.collection("todos").query({ index: "byTitle" })).docs.map((d) => d.id)).toEqual(["2"]);
    await old.kv.sync();
    expect(await codeOf(old.store.collection("todos").query({ index: "byTitle" }))).toBe("schema");
    expect(await old.store.collection("todos").count({ index: "byCreated" })).toBe(2);
    await next.store.whenIdle();
    expect(await keysUnder(next.kv, oldTitles)).toBe(0);
  });

  it("finishes a query in the state it started in when a newer schema redefines its index meanwhile", async () => {
    const name = freshName();
    const old = await at(name, v1);
    const docs = rows(10);
    await old.store.collection("todos").putMany(docs);
    const readerKv = await kvOn(name);
    let scanning!: () => void;
    const scanStarted = new Promise<void>((r) => (scanning = r));
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const reader = await openOn(
      wrapViews(readerKv, (snap) => ({
        rangeValues: async (range, decode) => {
          scanning();
          await released;
          return snap.rangeValues(range, decode);
        },
      })),
      v1,
    );
    const query = reader.collection("todos").queryIds({ index: "byTitle" });
    await scanStarted;
    await at(name, defineSchema({ version: 2, collections: { todos: byCreated.index("byTitle", "slug") } }));
    await readerKv.sync();
    release();
    const byTitle = [...docs].sort((a, b) => a.title!.localeCompare(b.title!) || a.id.localeCompare(b.id));
    expect((await query).ids).toEqual(byTitle.map((d) => d.id));
    expect(await codeOf(reader.collection("todos").queryIds({ index: "byTitle" }))).toBe("schema");
  });

  it("sweeps every key of a removed index", async () => {
    const name = freshName();
    const old = await at(name, v1);
    await old.store.collection("todos").putMany(rows(50));
    const titles = await storedPrefix(old.kv, "todos", "byTitle");
    expect(await keysUnder(old.kv, titles)).toBe(50);
    const next = await at(name, defineSchema({ version: 2, collections: { todos: byCreated } }));
    await next.store.whenIdle();
    expect(await keysUnder(next.kv, titles)).toBe(0);
    expect((await storedCatalog(next.kv)).dropped).toEqual([]);
  });

  it("rebuilds an index whose include a newer version adds, changes or removes, over the rows written before", async () => {
    const name = freshName();
    const docs = rows(40);
    await (await at(name, v1)).store.collection("todos").putMany(docs);
    const byCreatedIn = (version: number, include?: readonly ["title" | "done", ...("title" | "done")[]]) =>
      defineSchema({ version, collections: { todos: include ? base.index("list", "createdAt", { include }) : base.index("list", "createdAt") } });
    const fieldsAt = async (version: number, include?: readonly ["title" | "done", ...("title" | "done")[]]) => {
      const { store } = await at(name, byCreatedIn(version, include));
      await store.whenIdle();
      return (await store.collection("todos").queryEntries({ index: "list" })).entries.map((e) => ("fields" in e ? e.fields : "none"));
    };
    expect(await fieldsAt(2, ["title"])).toStrictEqual(docs.map((d) => ({ title: d.title })));
    expect(await fieldsAt(3, ["done", "title"])).toStrictEqual(docs.map((d) => ({ done: d.done, title: d.title })));
    expect(await fieldsAt(4)).toStrictEqual(docs.map(() => "none"));
    expect(await fieldsAt(5, ["done"])).toStrictEqual(docs.map((d) => ({ done: d.done })));
  });

  it("keeps the rows of a collection a newer schema leaves out, for a later schema that declares it again", async () => {
    type Note = { id: string; body: string };
    const name = freshName();
    const both = (version: number) =>
      defineSchema({ version, collections: { todos: byCreated, notes: collection<Note>().index("byBody", "body") } });
    const first = await at(name, both(1));
    await first.store.collection("notes").putMany([{ id: "n1", body: "x" }, { id: "n2", body: "y" }]);
    const second = await at(name, defineSchema({ version: 2, collections: { todos: byCreated } }));
    await second.store.whenIdle();
    const third = await at(name, both(3));
    expect((await third.store.collection("notes").query({ index: "byBody" })).docs).toEqual([
      { id: "n1", body: "x" },
      { id: "n2", body: "y" },
    ]);
  });

  it("deletes every key of a dropped collection, and the older schema's handle can no longer use it", async () => {
    type Note = { id: string; body: string };
    const name = freshName();
    const both = defineSchema({
      version: 1,
      collections: { todos: byCreated, notes: collection<Note>().index("byBody", "body") },
    });
    const old = await at(name, both);
    await old.store.collection("todos").putMany(rows(5));
    await old.store.collection("notes").putMany(Array.from({ length: 50 }, (_, i) => ({ id: `n${i}`, body: `b${i}` })));
    const notes = await storedPrefix(old.kv, "notes");
    const next = await at(
      name,
      defineSchema({ version: 2, collections: { todos: byCreated }, drop: ["notes"] }),
    );
    await next.store.whenIdle();
    const catalog = await storedCatalog(next.kv);
    expect(catalog.collections["notes"]).toBeUndefined();
    expect(catalog.dropped).toEqual([]);
    expect(await keysUnder(next.kv, notes)).toBe(0);
    expect(await next.store.collection("todos").count({ index: "byCreated" })).toBe(5);
    expect(await codeOf(old.store.collection("notes").get("n1"))).toBe("schema");
    expect(await codeOf(old.store.collection("notes").put({ id: "n1", body: "x" }))).toBe("schema");
  });

  it("opens an older schema after a newer one is stored, writing and reading its unchanged indexes", async () => {
    const name = freshName();
    await at(name, defineSchema({ version: 2, collections: { todos: byCreated } }));
    const old = await at(name, v1);
    await old.store.collection("todos").put({ id: "1", title: "t", createdAt: 1 });
    expect((await old.store.collection("todos").queryIds({ index: "byCreated" })).ids).toEqual(["1"]);
    expect(await codeOf(old.store.collection("todos").query({ index: "byTitle" }))).toBe("schema");
  });

  it("keeps the included fields of a newer schema's index in a write from an older handle that declares none", async () => {
    const name = freshName();
    const list = (version: number, include?: readonly ["title"]) =>
      defineSchema({ version, collections: { todos: include ? byCreated.index("list", "createdAt", { include }) : byCreated.index("list", "createdAt") } });
    const old = await at(name, list(1));
    const next = await at(name, list(2, ["title"]));
    await next.store.whenIdle();
    await old.store.collection("todos").put({ id: "1", title: "from the old handle", createdAt: 1 });
    await old.store.collection("todos").put({ id: "2", createdAt: 2 });
    await next.kv.sync();
    expect((await next.store.collection("todos").queryEntries({ index: "list" })).entries).toStrictEqual([
      { id: "1", values: [1], fields: { title: "from the old handle" } },
      { id: "2", values: [2], fields: {} },
    ]);
  });

  it("refuses a document whose included fields pass 1 MiB in one index, and fails the index over such a row written before it", async () => {
    const name = freshName();
    const big = { id: "big", title: "x".repeat(600 * 1024), createdAt: 1, label: ["a", "b"] };
    const todos = collection<{ id: string; title?: string; createdAt?: number; label?: string[] }>().index("byCreated", "createdAt");
    const old = await at(name, defineSchema({ version: 1, collections: { todos } }));
    await old.store.collection("todos").putMany([big, { id: "small", title: "t", createdAt: 2, label: ["a"] }]);
    const next = await at(
      name,
      defineSchema({
        version: 2,
        collections: { todos: todos.index("once", "createdAt", { include: ["title"] }).index("perLabel", ["label[]", "createdAt"], { include: ["title"] }) },
      }),
    );
    const c = next.store.collection("todos");
    expect((await c.queryEntries({ index: "once" })).entries.map((e) => e.fields.title?.length)).toStrictEqual([600 * 1024, 1]);
    expect(await c.queryEntries({ index: "perLabel" }).catch((e: unknown) => e)).toMatchObject({ code: "index-failed", ids: ["big"] });
    expect(await codeOf(c.put({ id: "huge", title: "x".repeat(1100 * 1024), createdAt: 3 }))).toBe("document");
    expect(await c.get("huge")).toBeUndefined();
    await c.put({ ...big, title: "now small" });
    expect((await c.get("big"))?.title).toBe("now small");
  });

  it("fills an index when a document with a thousand long entries follows a backfill step that is almost full", async () => {
    const name = freshName();
    const todos = collection<{ id: string; title?: string; label?: string[] }>();
    const old = await at(name, defineSchema({ version: 1, collections: { todos } }));
    const labels = Array.from({ length: 100 }, (_, i) => `l${i}`);
    await old.store.collection("todos").putMany(
      Array.from({ length: 72 }, (_, i) => ({ id: `a${String(i).padStart(2, "0")}`, title: "t".repeat(500), label: labels })),
    );
    await old.store.collection("todos").put({
      id: "z",
      title: "t".repeat(1000),
      label: Array.from({ length: 1000 }, (_, i) => String(i).padStart(1600, "x")),
    });
    const next = await at(name, defineSchema({ version: 2, collections: { todos: todos.index("perLabel", "label[]", { include: ["title"] }) } }));
    await next.store.whenIdle();
    expect(await next.store.collection("todos").count({ index: "perLabel" })).toBe(8200);
  });

  it("resolves two handles opening the next version at once, with its definitions stored once", async () => {
    const name = freshName();
    await at(name, v1);
    const [a] = await Promise.all([at(name, v2), at(name, v2)]);
    const catalog = await storedCatalog(a.kv);
    const indexes = catalog.collections["todos"]!.indexes;
    expect(catalog.version).toBe(2);
    expect(Object.keys(indexes).sort()).toEqual(["byCreated", "byDone", "byTitle"]);
    expect(new Set(Object.values(indexes).map((i) => i.id)).size).toBe(3);
    expect(Object.values(indexes).every((i) => i.state.kind === "ready")).toBe(true);
  });
});

describe("indexes the stored data cannot fill", () => {
  it("fails a unique index over duplicates with both ids, keeps the rest working, and rebuilds it at the next version", async () => {
    const name = freshName();
    const old = await at(name, v1);
    await old.store.collection("todos").putMany([
      { id: "a", slug: "s", createdAt: 1 },
      { id: "b", slug: "s", createdAt: 2 },
      { id: "c", slug: "t", createdAt: 3 },
    ]);
    const next = await at(name, unique(2));
    const todos = next.store.collection("todos");
    const err = await todos.query({ index: "bySlug" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "index-failed" });
    expect([...(err as { ids: string[] }).ids].sort()).toEqual(["a", "b"]);
    await todos.put({ id: "d", slug: "s", createdAt: 4 });
    expect((await todos.queryIds({ index: "byCreated" })).ids).toEqual(["a", "b", "c", "d"]);
    const failed = await storedPrefix(next.kv, "todos", "bySlug");
    await next.store.whenIdle();
    expect(await keysUnder(next.kv, failed)).toBe(0);

    await todos.deleteMany(["b", "d"]);
    const fixed = await at(name, unique(3));
    expect((await fixed.store.collection("todos").queryIds({ index: "bySlug", eq: ["s"] })).ids).toEqual(["a"]);
  });

  it("sweeps the entries a unique backfill wrote before it met a duplicate", async () => {
    const name = freshName();
    const old = await at(name, v1);
    const docs = rows(600).map((d, i) => ({ ...d, slug: i === 550 ? "r0000" : d.id }));
    await old.store.collection("todos").putMany(docs);
    const next = await at(name, unique(2));
    expect(await codeOf(next.store.collection("todos").query({ index: "bySlug" }))).toBe("index-failed");
    const failed = await storedPrefix(next.kv, "todos", "bySlug");
    await next.store.whenIdle();
    expect(await keysUnder(next.kv, failed)).toBe(0);
  });

  it("fails an index when a row written before it holds a value it cannot index, naming that row", async () => {
    const name = freshName();
    const old = await at(name, v1);
    await old.store.collection("todos").putMany([
      { id: "x", label: { o: 1 }, createdAt: 1 },
      { id: "y", label: "fine", createdAt: 2 },
    ]);
    const next = await at(name, labelled);
    const todos = next.store.collection("todos");
    const err = await todos.query({ index: "byLabel" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "index-failed", ids: ["x"] });
    await todos.put({ id: "z", label: "new", createdAt: 3 });
    expect(await todos.count({ index: "byCreated" })).toBe(3);
  });

  it("lets a write replace a row whose old value the building index cannot hold", async () => {
    const name = freshName();
    const old = await at(name, v1);
    await old.store.collection("todos").put({ id: "x", label: { o: 1 }, createdAt: 1 });
    const held = gate(await kvOn(name), "range", 0);
    const opening = openOn(held.db, labelled);
    await held.arrived(1);
    await old.store.collection("todos").put({ id: "x", label: "fixed", createdAt: 1 });
    held.release();
    const next = await opening;
    expect((await next.collection("todos").queryIds({ index: "byLabel", eq: ["fixed"] })).ids).toEqual(["x"]);
  });

  it("keeps a unique entry the backfill gave one row when another row that shared its value changes", async () => {
    const name = freshName();
    const old = await at(name, v1);
    const docs = rows(600).map((d, i) => (i === 0 || i === 550 ? { ...d, slug: "x" } : d));
    await old.store.collection("todos").putMany(docs);
    const held = gate(await kvOn(name), "range", 1);
    const opening = openOn(held.db, unique(2));
    await held.arrived(2);
    await old.store.collection("todos").modify("r0550", (d) => ({ ...d, slug: "y" }));
    held.release();
    const todos = (await opening).collection("todos");
    expect((await todos.queryIds({ index: "bySlug", eq: ["x"] })).ids).toEqual(["r0000"]);
    expect((await todos.queryIds({ index: "bySlug", eq: ["y"] })).ids).toEqual(["r0550"]);
  });

  it("keeps a unique entry the backfill gave one row when modifyMany changes the other row that shared its value and deletes a third", async () => {
    const name = freshName();
    const old = await at(name, v1);
    const docs = rows(600).map((d, i) => (i === 0 || i === 550 ? { ...d, slug: "x" } : d));
    await old.store.collection("todos").putMany(docs);
    const held = gate(await kvOn(name), "range", 1);
    const opening = openOn(held.db, unique(2));
    await held.arrived(2);
    await old.store.collection("todos").modifyMany(["r0550", "r0001"], ([shared]) => [{ ...shared!, slug: "y" }, null]);
    held.release();
    const todos = (await opening).collection("todos");
    expect((await todos.queryIds({ index: "bySlug", eq: ["x"] })).ids).toEqual(["r0000"]);
    expect((await todos.queryIds({ index: "bySlug", eq: ["y"] })).ids).toEqual(["r0550"]);
    expect(await todos.count({ index: "byCreated" })).toBe(599);
  });

  it("fails a unique index when a write gave a row's value to another row before the backfill reached that row", async () => {
    const name = freshName();
    const old = await at(name, v1);
    await old.store.collection("todos").putMany(rows(600).map((d, i) => (i === 550 ? { ...d, slug: "x" } : d)));
    const held = gate(await kvOn(name), "range", 1);
    const opening = openOn(held.db, unique(2));
    await held.arrived(2);
    await old.store.collection("todos").put({ id: "a", slug: "x", createdAt: -1 });
    held.release();
    const err = await (await opening).collection("todos").query({ index: "bySlug" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "index-failed" });
    expect([...(err as { ids: string[] }).ids].sort()).toEqual(["a", "r0550"]);
  });

  it("accepts an unchanged put of a row whose unique value the building index gave another row", async () => {
    const name = freshName();
    const old = await at(name, v1);
    const docs = rows(600).map((d, i) => (i === 0 || i === 550 ? { ...d, slug: "x" } : d));
    await old.store.collection("todos").putMany(docs);
    const held = gate(await kvOn(name), "range", 1);
    const opening = openOn(held.db, unique(2));
    await held.arrived(2);
    expect(await codeOf(old.store.collection("todos").put(docs[550]!))).toBe("no error");
    held.release();
    expect(await codeOf((await opening).collection("todos").query({ index: "bySlug" }))).toBe("index-failed");
  });
});

describe("clear", () => {
  it("clears documents with 800 multi entries each in one write, and reads see nothing once it resolves", async () => {
    const { store } = await at(freshName(), tagged);
    const c = store.collection("tagged");
    const tags = Array.from({ length: 800 }, (_, i) => `tag${i}`);
    for (let i = 0; i < 20; i += 10) {
      await c.putMany(Array.from({ length: 10 }, (_, j) => ({ id: `d${i + j}`, tags })));
    }
    await c.clear();
    expect(await c.count({})).toBe(0);
    expect(await c.count({ index: "byTag" })).toBe(0);
    expect((await c.query({ index: "byTag", eq: ["tag1"] })).docs).toEqual([]);
    expect(await c.get("d0")).toBeUndefined();
  });

  it("leaves no key under the old collection prefix once the store is idle", async () => {
    const { kv, store } = await at(freshName(), v1);
    await store.collection("todos").putMany(rows(2_500));
    const old = await storedPrefix(kv, "todos");
    await store.collection("todos").clear();
    await store.whenIdle();
    expect(await keysUnder(kv, old)).toBe(0);
    expect((await storedCatalog(kv)).dropped).toEqual([]);
  });

  it("sweeps the entries of index id 255, the last id a collection can give", async () => {
    let todos = collection<Todo>();
    for (let i = 0; i < 255; i++) todos = todos.index(`i${i}`, "createdAt") as never;
    const wide = defineSchema({ version: 1, collections: { todos } });
    const { kv, store } = await at(freshName(), wide);
    await store.collection("todos").put({ id: "1", createdAt: 1 });
    expect(Object.values((await storedCatalog(kv)).collections["todos"]!.indexes).map((i) => i.id)).toContain(255);
    const old = await storedPrefix(kv, "todos");
    expect(await keysUnder(kv, old)).toBe(256);
    await store.collection("todos").clear();
    await store.whenIdle();
    expect(await keysUnder(kv, old)).toBe(0);
  });

  it("keeps two collections apart once clears give one an id 256 above the other's", async () => {
    const { kv, store } = await at(freshName(), defineSchema({ version: 1, collections: { a: base, b: base } }));
    const [a, b] = [store.collection("a"), store.collection("b")];
    const ids = async () => Object.values((await storedCatalog(kv)).collections).map((c) => c.id);
    expect(await ids()).toEqual([1, 2]);
    for (let i = 0; i < 255; i++) await b.clear();
    expect(await ids()).toEqual([1, 257]);
    await store.whenIdle();
    await a.put({ id: "1", title: "a", createdAt: 1 });
    await b.put({ id: "2", title: "b", createdAt: 2 });
    for (const [c, id] of [[a, "1"], [b, "2"]] as const) {
      expect((await c.queryIds({})).ids).toEqual([id]);
      expect((await c.queryIds({ index: "byCreated" })).ids).toEqual([id]);
      expect((await c.queryIds({ index: "byTitle" })).ids).toEqual([id]);
    }
    expect(await b.get("1")).toBeUndefined();
  });

  it("keeps a put that resolves after clear resolved, alone", async () => {
    const { store } = await at(freshName(), v1);
    const todos = store.collection("todos");
    await todos.putMany(rows(10));
    await todos.clear();
    await todos.put({ id: "after", title: "t", createdAt: 1 });
    expect((await todos.queryIds({})).ids).toEqual(["after"]);
    expect((await todos.queryIds({ index: "byTitle" })).ids).toEqual(["after"]);
  });

  it("leaves a put racing a clear from another handle either cleared or present with all its entries", async () => {
    const name = freshName();
    const a = await at(name, v1);
    const b = await at(name, v1);
    for (let round = 0; round < 10; round++) {
      await Promise.all([
        a.store.collection("todos").put({ id: `p${round}`, title: "t", createdAt: round }),
        b.store.collection("todos").clear(),
      ]);
      await a.kv.sync();
      const todos = a.store.collection("todos");
      const present = (await todos.count({})) === 1;
      expect(await todos.count({ index: "byCreated" })).toBe(present ? 1 : 0);
      expect(await todos.count({ index: "byTitle" })).toBe(present ? 1 : 0);
      await todos.clear();
    }
  });

  it("writes one catalog op and scans nothing, in the clear or in its sweep, whatever the size", async () => {
    for (const n of [10, 20_000]) {
      const kv = await kvOn(freshName());
      let scans = 0;
      const { db, updates } = recording(wrap(kv, { range: (r) => (scans++, kv.range(r)) }));
      const store = await openOn(db, v1);
      const todos = store.collection("todos");
      for (let i = 0; i < n; i += 2_000) await todos.putMany(rows(Math.min(2_000, n - i), i));
      updates.length = 0;
      scans = 0;
      await todos.clear();
      expect({ updates, scans }).toEqual({ updates: [{ reads: 1, puts: 1, deletes: 0 }], scans: 0 });
      await store.whenIdle();
      expect(scans).toBe(0);
    }
  });

  it("refuses a cursor made before the clear", async () => {
    const { store } = await at(freshName(), v1);
    const todos = store.collection("todos");
    await todos.putMany(rows(5));
    const { next } = await todos.query({ index: "byCreated", limit: 2 });
    await todos.clear();
    await todos.putMany(rows(5));
    expect(await codeOf(todos.query({ index: "byCreated", after: next }))).toBe("cursor");
  });

  it("gives a read racing a clear and its sweep the whole old result or the new one, at every sweep chunk", async () => {
    type Todos = ReturnType<DocStore<typeof v1>["collection"]>;
    const docs = rows(1_500);
    const ids = docs.map((d) => d.id);
    const reads: [string, (c: Todos) => Promise<unknown>, unknown][] = [
      ["rows", async (c) => (await c.queryIds({})).ids, ids],
      ["queryIds", async (c) => (await c.queryIds({ index: "byCreated" })).ids, ids],
      ["query", async (c) => (await c.query({ index: "byCreated" })).docs.map((d) => d.id), ids],
      ["count", (c) => c.count({ index: "byTitle" }), ids.length],
    ];
    for (let chunks = 0; chunks <= 5; chunks++) {
      for (const [, read, whole] of reads) {
        const name = freshName();
        await (await at(name, v1)).store.collection("todos").putMany(docs);
        const sweeper = gate(await kvOn(name), "catalog-or-batch", chunks + 1);
        const clearing = await openOn(sweeper.db, v1);
        const readerKv = await kvOn(name);
        let armed = false;
        const readerDb = wrapViews(readerKv, (snap) => ({
          async get(key) {
            const value = await snap.get(key);
            if (armed) {
              armed = false;
              await clearing.collection("todos").clear();
              await Promise.race([sweeper.arrived(chunks + 2), clearing.whenIdle()]);
              await readerKv.sync();
            }
            return value;
          },
        }));
        const reader = (await openOn(readerDb, v1)).collection("todos");
        armed = true;
        const got = await read(reader);
        expect([whole, Array.isArray(whole) ? [] : 0]).toContainEqual(got);
        sweeper.release();
      }
    }
  }, 60_000);
});

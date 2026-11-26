import { prefixBound, type BatchTx, type Db, type ViewSnapshot } from "@opfs-lsm/kv";
import { destroyHarnessDb } from "@opfs-lsm/kv/testing";
import { afterEach, describe, expect, it } from "vitest";
import { encodeCatalog, type StoredCatalog } from "../src/catalog.js";
import { collection, defineSchema, openDocStore } from "../src/index.js";
import { CATALOG_KEY, bytesEqual } from "../src/keys.js";
import { codeOf, freshName, openKv, openKvWithoutBus, recording, storedCatalog, wrap, wrapViews } from "./harness.js";

type Todo = { id: string; title?: string; done?: boolean };

const v1 = defineSchema({ version: 1, collections: { todos: collection<Todo>().index("byTitle", "title") } });
const v2 = defineSchema({ version: 2, collections: { todos: collection<Todo>().index("byTitle", "title").index("byDone", "done") } });
const byDone = defineSchema({ version: 1, collections: { todos: collection<Todo>().index("byDone", "done") } });
const other = defineSchema({ version: 1, collections: { notes: collection<{ id: string }>() } });

const open: Db[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((kv) => kv.close()));
});

async function kvOn(name: string): Promise<Db> {
  const kv = await openKv(name);
  open.push(kv);
  return kv;
}

describe("a reader and the catalog", () => {
  it("counts a collection another handle cleared as empty, and sees what it writes next", async () => {
    const name = freshName();
    const readerKv = await kvOn(name);
    const reader = (await openDocStore(readerKv, v1)).collection("todos");
    const writer = (await openDocStore(await kvOn(name), v1)).collection("todos");
    await writer.putMany([{ id: "a", title: "x" }, { id: "b", title: "y" }]);
    await readerKv.sync();
    expect(await reader.count({ index: "byTitle" })).toBe(2);

    await writer.clear();
    await readerKv.sync();
    expect(await reader.count({ index: "byTitle" })).toBe(0);
    await writer.put({ id: "c", title: "z" });
    await readerKv.sync();
    expect((await reader.query({ index: "byTitle" })).docs.map((d) => d.id)).toEqual(["c"]);
  });

  it("queries an index another handle's newer schema added", async () => {
    const name = freshName();
    const readerKv = await kvOn(name);
    const reader = (await openDocStore(readerKv, v1)).collection("todos");
    await reader.putMany([{ id: "a", title: "x", done: true }, { id: "b", title: "y", done: false }]);

    await openDocStore(await kvOn(name), v2);
    await readerKv.sync();
    expect(await reader.count({ index: "byTitle" })).toBe(2);
    expect(await reader.put({ id: "c", title: "z", done: true })).toBeUndefined();
    expect(await reader.count({ index: "byTitle" })).toBe(3);
  });

  it("reads what another handle cleared and wrote between this store's read of the catalog and its subscription", async () => {
    const name = freshName();
    const writer = (await openDocStore(await kvOn(name), v1)).collection("todos");
    await writer.put({ id: "a", title: "x" });
    const kv = await kvOn(name);
    let raced = false;
    const racing = wrap(kv, {
      get: async (key) => {
        const value = await kv.get(key);
        if (raced) return value;
        raced = true;
        await writer.clear();
        await writer.put({ id: "a", title: "y" });
        await kv.sync();
        return value;
      },
    });
    const reader = (await openDocStore(racing, v1)).collection("todos");
    expect(raced).toBe(true);
    expect(await reader.get("a")).toEqual({ id: "a", title: "y" });
    expect((await reader.query({ index: "byTitle" })).docs).toEqual([{ id: "a", title: "y" }]);
  });

  it.each<[string, (tx: BatchTx, catalogSeq: number) => void]>([
    ["deleted the catalog", (tx) => tx.delete(CATALOG_KEY)],
    ["range-deleted the catalog", (tx) => tx.deleteRange(prefixBound(CATALOG_KEY))],
    // The rows written after the catalog stay.
    ["range-deleted every key from the catalog on, through the catalog's seq", (tx, through) => tx.deleteRange({ start: CATALOG_KEY }, { through })],
  ])("reads a store as empty once another layer %s", async (_, remove) => {
    const kv = await kvOn(freshName());
    // Another collection takes id 1, so the rows are not where a store with no catalog looks.
    await openDocStore(kv, other);
    const store = await openDocStore(kv, defineSchema({ version: 2, collections: v1.collections, drop: ["notes"] }));
    const todos = store.collection("todos");
    const catalogSeq = await kv.view((snap) => snap.seq);
    await todos.put({ id: "a", title: "y" });
    expect(await todos.get("a")).toEqual({ id: "a", title: "y" });

    await kv.batch((tx) => remove(tx, catalogSeq));
    expect(await todos.get("a")).toBeUndefined();
    expect(await todos.getMany(["a"])).toEqual([undefined]);
    expect(await todos.count({ index: "byTitle" })).toBe(0);
  });

  it("throws schema from every read once another layer stored a catalog of another format", async () => {
    const kv = await kvOn(freshName());
    const todos = (await openDocStore(kv, v1)).collection("todos");
    await todos.put({ id: "a", title: "x" });
    expect(await todos.get("a")).toEqual({ id: "a", title: "x" });

    await kv.put(CATALOG_KEY, encodeCatalog({ ...(await storedCatalog(kv)), format: 99 } as unknown as StoredCatalog));
    expect(await codeOf(todos.get("a"))).toBe("schema");
    expect(await codeOf(todos.getMany(["a"]))).toBe("schema");
    expect(await codeOf(todos.count({ index: "byTitle" }))).toBe("schema");
  });

  it("reads the catalog once while the only writes are its own handle's", async () => {
    const kv = await kvOn(freshName());
    let catalogReads = 0;
    const counted = wrapViews(kv, (snap) => ({
      getMany: ((...args: Parameters<ViewSnapshot["getMany"]>) => {
        if (bytesEqual(args[0][0], CATALOG_KEY)) catalogReads++;
        return snap.getMany(...args);
      }) as ViewSnapshot["getMany"],
    }));
    const store = await openDocStore(counted, v1);
    const todos = store.collection("todos");
    await todos.put({ id: "a", title: "x" });
    expect(await todos.get("a")).toEqual({ id: "a", title: "x" });
    await todos.put({ id: "b", title: "y" });
    expect(await todos.getMany(["a", "b"])).toEqual([{ id: "a", title: "x" }, { id: "b", title: "y" }]);
    expect(await todos.count({ index: "byTitle" })).toBe(2);
    await todos.clear();
    await todos.put({ id: "c", title: "z" });
    await store.whenIdle();
    expect(await todos.get("c")).toEqual({ id: "c", title: "z" });
    expect((await todos.query({ index: "byTitle" })).docs).toEqual([{ id: "c", title: "z" }]);
    expect(catalogReads).toBe(1);
  });
});

describe("a store held across dangerousDestroy", () => {
  it("reads empty and keeps writing after another handle's destroy, before any store writes a catalog", async () => {
    const name = freshName();
    const heldKv = await kvOn(name);
    const held = (await openDocStore(heldKv, v1)).collection("todos");
    await held.putMany([{ id: "a", title: "x" }, { id: "b", title: "y" }]);

    await (await kvOn(name)).dangerousDestroy();
    await heldKv.sync();
    expect(await held.get("a")).toBeUndefined();
    expect(await held.count({ index: "byTitle" })).toBe(0);
    expect(await held.view((snap) => snap.count({ index: "byTitle" }))).toBe(0);

    await held.put({ id: "c", title: "z" });
    expect((await held.query({ index: "byTitle" })).docs.map((d) => d.id)).toEqual(["c"]);
  });

  it("keeps writing after its own handle's destroy", async () => {
    const kv = await kvOn(freshName());
    const held = (await openDocStore(kv, v1)).collection("todos");
    await held.put({ id: "a", title: "x" });

    await kv.dangerousDestroy();
    expect(await held.count({ index: "byTitle" })).toBe(0);
    await held.put({ id: "b", title: "y" });
    expect((await held.query({ index: "byTitle" })).docs.map((d) => d.id)).toEqual(["b"]);
  });

  it("refuses a collection the reopened database does not have", async () => {
    const kv = await kvOn(freshName());
    const held = (await openDocStore(kv, v1)).collection("todos");
    await held.put({ id: "a", title: "x" });

    await kv.dangerousDestroy();
    await openDocStore(kv, other);
    expect(await codeOf(held.count({ index: "byTitle" }))).toBe("schema");
  });

  it("does not read the new database's index through the held store's definition", async () => {
    const kv = await kvOn(freshName());
    const held = (await openDocStore(kv, v1)).collection("todos");
    await held.putMany([{ id: "a", title: "x", done: true }]);

    await kv.dangerousDestroy();
    const fresh = (await openDocStore(kv, byDone)).collection("todos");
    await fresh.putMany([{ id: "b", title: "y", done: true }, { id: "c", title: "z", done: false }]);
    expect(await codeOf(held.count({ index: "byTitle" }))).toBe("schema");
    expect(await fresh.count({ index: "byDone" })).toBe(2);
  });
});

describe("destroyDb of one of two names", () => {
  it("closes the stores on that name, and leaves the stores on the other reading and writing", async () => {
    const [nameA, nameB] = [freshName(), freshName()];
    const a = (await openDocStore(await kvOn(nameA), v1)).collection("todos");
    const onA: unknown[] = [];
    a.changes((event) => onA.push(event));
    const bStore = await openDocStore(await kvOn(nameB), v1);
    const b = bStore.collection("todos");
    const onB: { kind: string }[] = [];
    b.changes((event) => onB.push(event));
    const readerKv = await kvOn(nameB);
    const bReader = (await openDocStore(readerKv, v1)).collection("todos");
    await a.putMany([{ id: "a", title: "x" }, { id: "b", title: "y" }]);
    await b.putMany([{ id: "a", title: "p" }, { id: "c", title: "q" }]);

    await destroyHarnessDb({ name: nameA, forceMemory: true });

    expect(onA.at(-1)).toEqual({ kind: "closed", reason: "destroyed" });
    expect(onB.some((event) => event.kind === "closed")).toBe(false);
    expect(await codeOf(a.count({ index: "byTitle" }))).toBe("closed");
    expect(await codeOf(a.put({ id: "d", title: "z" }))).toBe("closed");
    expect((await b.query({ index: "byTitle" })).docs.map((d) => d.id)).toEqual(["a", "c"]);
    await b.put({ id: "d", title: "r" });
    await bStore.whenIdle();
    await readerKv.sync();
    expect(await bReader.count({ index: "byTitle" })).toBe(3);

    const reopened = (await openDocStore(await kvOn(nameA), v1)).collection("todos");
    expect(await reopened.count({ index: "byTitle" })).toBe(0);
    await reopened.put({ id: "e", title: "s" });
    expect((await reopened.query({ index: "byTitle" })).docs.map((d) => d.id)).toEqual(["e"]);
    expect(await b.get("a")).toEqual({ id: "a", title: "p" });
  });
});

describe("opening a schema the stored catalog already satisfies", () => {
  it("leaves the stored catalog as it is, for the same version and a lower one", async () => {
    const kv = await kvOn(freshName());
    await openDocStore(kv, v2);
    const before = await kv.get(CATALOG_KEY);

    const { db, updates } = recording(kv);
    await openDocStore(db, v2);
    await openDocStore(db, v1);
    expect(await kv.get(CATALOG_KEY)).toEqual(before);
    expect(updates).toEqual([]);
  });

  it("opens a lower version than another handle stored, before this handle has read that catalog", async () => {
    const name = freshName();
    const kv = await openKvWithoutBus(name);
    open.push(kv);
    await openDocStore(kv, v1);
    await openDocStore(await kvOn(name), v2);
    const todos = (await openDocStore(kv, byDone)).collection("todos");
    expect(await todos.count({ index: "byDone" })).toBe(0);
  });

  it("writes the catalog when the declared version is higher", async () => {
    const kv = await kvOn(freshName());
    await openDocStore(kv, v1);
    const before = await kv.get(CATALOG_KEY);
    await openDocStore(kv, v2);
    expect(await kv.get(CATALOG_KEY)).not.toEqual(before);
  });
});

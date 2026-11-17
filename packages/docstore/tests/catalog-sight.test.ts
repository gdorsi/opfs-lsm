import type { Db } from "@opfs-lsm/kv";
import { afterEach, describe, expect, it } from "vitest";
import { defineSchema, openDocStore } from "../src/index.js";
import { CATALOG_KEY } from "../src/keys.js";
import { codeOf, freshName, openKv, recording } from "./harness.js";

type Todo = { id: string; title?: string; done?: boolean };

const v1 = defineSchema<{ todos: Todo }>()({ version: 1, collections: { todos: { byTitle: { by: "title" } } } });
const v2 = defineSchema<{ todos: Todo }>()({ version: 2, collections: { todos: { byTitle: { by: "title" }, byDone: { by: "done" } } } });
const byDone = defineSchema<{ todos: Todo }>()({ version: 1, collections: { todos: { byDone: { by: "done" } } } });
const other = defineSchema<{ notes: { id: string } }>()({ version: 1, collections: { notes: {} } });

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

  it("writes the catalog when the declared version is higher", async () => {
    const kv = await kvOn(freshName());
    await openDocStore(kv, v1);
    const before = await kv.get(CATALOG_KEY);
    await openDocStore(kv, v2);
    expect(await kv.get(CATALOG_KEY)).not.toEqual(before);
  });
});

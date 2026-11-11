import type { Db } from "@opfs-lsm/kv";
import { afterEach, describe, expect, it } from "vitest";
import { defineSchema, openDocStore } from "../src/index.js";
import { schema, type Doc, type Docs } from "./docs.js";
import { codeOf, freshName, openKv } from "./harness.js";

const open: Db[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((kv) => kv.close()));
});

async function docs(name = freshName()): Promise<{ kv: Db; c: Docs }> {
  const kv = await openKv(name);
  open.push(kv);
  return { kv, c: (await openDocStore(kv, schema)).collection("docs") };
}

describe("indexes", () => {
  it("lists what the schema declares: the kind, the paths, and whether it is unique", async () => {
    const { c } = await docs();
    expect(new Map(c.indexes)).toEqual(
      new Map([
        ["one", { kind: "sorted", on: ["a"], unique: false }],
        ["two", { kind: "sorted", on: ["a", "b"], unique: false }],
        ["tags", { kind: "multi", on: ["tags", "b"], unique: false }],
        ["uniq", { kind: "sorted", on: ["u"], unique: true }],
        ["search", { kind: "text", on: ["a"], unique: false, text: "t" }],
      ]),
    );
  });

  it("lists only the indexes of this handle's schema when the stored catalog holds more", async () => {
    const name = freshName();
    type Row = { id: string; a?: number; b?: number };
    const v1 = defineSchema<{ rows: Row }>()({ version: 1, collections: { rows: { byA: { on: "a" } } } });
    const v2 = defineSchema<{ rows: Row }>()({
      version: 2,
      collections: { rows: { byA: { on: "a" }, byB: { on: "b", unique: true } } },
    });
    const kvNew = await openKv(name);
    const kvOld = await openKv(name);
    open.push(kvNew, kvOld);
    const next = (await openDocStore(kvNew, v2)).collection("rows");
    const old = (await openDocStore(kvOld, v1)).collection("rows");
    expect([...next.indexes.keys()]).toEqual(["byA", "byB"]);
    expect([...old.indexes.keys()]).toEqual(["byA"]);
  });
});

describe("view", () => {
  it("keeps what a write made after the body started out of every read of its snapshot", async () => {
    const { c } = await docs();
    await c.putMany([
      { id: "a", a: 1 },
      { id: "b", a: 2 },
    ]);
    await c.view(async (snap) => {
      expect((await snap.queryIds({ index: "one" })).ids).toEqual(["a", "b"]);
      await c.putMany([
        { id: "a", a: 3 },
        { id: "z", a: 0 },
      ]);
      await c.delete("b");
      expect(await snap.get("a")).toEqual({ id: "a", a: 1 });
      expect(await snap.getMany(["z", "b", "a"])).toEqual([undefined, { id: "b", a: 2 }, { id: "a", a: 1 }]);
      expect((await snap.query({ index: "one" })).docs).toEqual([
        { id: "a", a: 1 },
        { id: "b", a: 2 },
      ]);
      expect((await snap.queryIds({})).ids).toEqual(["a", "b"]);
      expect(await snap.count({ index: "one" })).toBe(2);
    });
    expect((await c.queryIds({ index: "one" })).ids).toEqual(["z", "a"]);
  });

  it("keeps a write from another handle out of the snapshot, even after that handle's write reached this one", async () => {
    const name = freshName();
    const a = await docs(name);
    const b = await docs(name);
    await a.c.put({ id: "x", a: 1 });
    await b.kv.sync();
    await a.c.view(async (snap) => {
      await b.c.put({ id: "y", a: 2 });
      await a.kv.sync();
      expect(await a.c.count({})).toBe(2);
      expect(await snap.count({})).toBe(1);
      expect(await snap.get("y")).toBeUndefined();
    });
  });

  it("gives queries on different indexes, getMany and get one state while documents change between them", async () => {
    const { c } = await docs();
    await c.putMany([
      { id: "x", a: 0, b: 0, tags: ["t0"] },
      { id: "y", a: 0, b: 0, tags: ["t0"] },
    ]);
    for (let round = 1; round <= 5; round++) {
      await c.view(async (snap) => {
        const first = await snap.getMany(["x", "y"]);
        await c.putMany([
          { id: "x", a: round, b: round, tags: [`t${round}`] },
          { id: "y", a: round, b: round, tags: [`t${round}`] },
        ]);
        const byOne = await snap.query({ index: "one" });
        const byTags = await snap.query({ index: "tags" });
        const byTwo = await snap.queryIds({ index: "two" });
        expect(byOne.docs).toEqual(first);
        expect(byTags.docs).toEqual(first);
        expect(byTwo.ids).toEqual(["x", "y"]);
        expect(await snap.count({ index: "one", eq: [round - 1] })).toBe(2);
        expect(await snap.count({ index: "one", eq: [round] })).toBe(0);
        expect(await snap.get("x")).toEqual(first[0]);
      });
    }
  });

  it("reads a collection as it was when the snapshot began, though it was cleared meanwhile", async () => {
    const { c } = await docs();
    await c.putMany([
      { id: "a", a: 1 },
      { id: "b", a: 2 },
    ]);
    await c.view(async (snap) => {
      await c.clear();
      await c.put({ id: "new", a: 9 });
      await c.view(async (after) => expect((await after.queryIds({})).ids).toEqual(["new"]));
      expect((await snap.query({ index: "one" })).docs.map((d: Doc) => d.id)).toEqual(["a", "b"]);
      expect(await snap.getMany(["a", "new"])).toEqual([{ id: "a", a: 1 }, undefined]);
    });
  });

  it("returns what the body returns and passes its error on", async () => {
    const { c } = await docs();
    await c.put({ id: "a", a: 1 });
    expect(await c.view(async (snap) => (await snap.get("a"))?.a)).toBe(1);
    await expect(
      c.view(async () => {
        throw new Error("from body");
      }),
    ).rejects.toThrow("from body");
  });

  it("runs the body once, and throws schema without running it for a collection the stored catalog lacks", async () => {
    const name = freshName();
    type Note = { id: string };
    const both = defineSchema<{ docs: Doc; notes: Note }>()({ version: 1, collections: { docs: {}, notes: {} } });
    const only = defineSchema<{ docs: Doc }>()({ version: 2, collections: { docs: {} }, drop: ["notes"] });
    const kvOld = await openKv(name);
    const kvNew = await openKv(name);
    open.push(kvOld, kvNew);
    const old = await openDocStore(kvOld, both);
    await openDocStore(kvNew, only);
    await kvOld.sync();
    let runs = 0;
    expect(
      await codeOf(
        old.collection("notes").view(async () => {
          runs++;
        }),
      ),
    ).toBe("schema");
    let docsRuns = 0;
    await old.collection("docs").view(async () => {
      docsRuns++;
    });
    expect({ runs, docsRuns }).toEqual({ runs: 0, docsRuns: 1 });
  });
});

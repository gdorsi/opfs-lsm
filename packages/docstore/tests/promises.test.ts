import { type Db } from "@opfs-lsm/kv";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { collection, defineSchema, openDocStore, type Cursor } from "../src/index.js";
import type { QueryInput } from "../src/schema.js";
import { MODEL, asQuery, datasetArb, queryArb, schema, type Doc } from "./docs.js";
import { codeOf, freshName, gate, openKv } from "./harness.js";
import { expected, stored } from "./oracle.js";

const open: Db[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((kv) => kv.close()));
});

async function kvOf(name = freshName()): Promise<Db> {
  const kv = await openKv(name);
  open.push(kv);
  return kv;
}

describe("offset after a cursor, and count with offset and limit", () => {
  it("skips offset results counted from after, and count stops at limit counted from offset", async () => {
    await expect(
      fc.assert(
        fc.asyncProperty(
          datasetArb,
          queryArb,
          fc.integer({ min: 1, max: 3 }),
          fc.integer({ min: 0, max: 4 }),
          fc.integer({ min: 1, max: 6 }),
          async (dataset, { index, q }, split, offset, limit) => {
            const kv = await openKv(freshName());
            try {
              const c = (await openDocStore(kv, schema)).collection("docs");
              await c.putMany(dataset);
              const want = expected(dataset.map(stored), index === undefined ? undefined : MODEL[index], q).map((h) => h.id);
              expect(await c.count(asQuery({ ...q, offset, limit }))).toBe(Math.min(limit, Math.max(0, want.length - offset)));
              const first = await c.queryIds(asQuery({ ...q, limit: split }));
              if (first.next === undefined) return;
              const rest = want.slice(split + offset);
              const withAfter = { ...q, after: first.next, offset } satisfies QueryInput;
              expect((await c.queryIds(asQuery(withAfter))).ids).toEqual(rest);
              expect((await c.query(asQuery({ ...withAfter, limit }))).docs.map((d) => d.id)).toEqual(rest.slice(0, limit));
              expect(await c.count(asQuery(withAfter))).toBe(rest.length);
              expect(await c.count(asQuery({ ...withAfter, limit }))).toBe(Math.min(limit, rest.length));
            } finally {
              await kv.close();
            }
          },
        ),
        { numRuns: 1500 },
      ),
    ).resolves.toBeUndefined();
  });
});

describe("documented errors and drops", () => {
  it("ignores a dropped name the catalog does not store", async () => {
    const kv = await kvOf();
    const v1 = defineSchema({ version: 1, collections: { docs: collection<Doc>() } });
    await (await openDocStore(kv, v1)).collection("docs").put({ id: "a" });
    const v2 = defineSchema({ version: 2, collections: { docs: collection<Doc>() }, drop: ["never"] });
    expect(await (await openDocStore(kv, v2)).collection("docs").get("a")).toEqual({ id: "a" });
  });

  it("throws cursor for an after made before its index was redefined", async () => {
    const kv = await kvOf();
    const v1 = defineSchema({ version: 1, collections: { docs: collection<Doc>().index("byA", "a") } });
    const c1 = (await openDocStore(kv, v1)).collection("docs");
    await c1.putMany([{ id: "x", a: 1 }, { id: "y", a: 2 }]);
    const { next } = await c1.queryIds({ index: "byA", limit: 1 });
    const v2 = defineSchema({ version: 2, collections: { docs: collection<Doc>().index("byA", ["a", "b"]) } });
    const c2 = (await openDocStore(kv, v2)).collection("docs");
    expect(await codeOf(c2.queryIds({ index: "byA", after: next as Cursor }))).toBe("cursor");
  });

  it("throws schema for a query on an index a newer schema is rebuilding, and reads it once it is ready", async () => {
    const name = freshName();
    const kv = await kvOf(name);
    const base = collection<Doc>().index("byA", "a");
    const v1 = defineSchema({ version: 1, collections: { docs: base } });
    const v2 = defineSchema({ version: 2, collections: { docs: base.unique("byU", "u") } });
    const v3 = defineSchema({ version: 3, collections: { docs: base.unique("byU", "u") } });
    await (await openDocStore(kv, v1)).collection("docs").putMany(Array.from({ length: 600 }, (_, i) => ({ id: `d${String(i).padStart(3, "0")}`, a: i, u: i < 2 ? "dup" : i })));
    const old = (await openDocStore(kv, v2)).collection("docs");
    expect(await codeOf(old.queryIds({ index: "byU" }))).toBe("index-failed");
    await old.put({ id: "d001", a: 1, u: "fixed" });
    const held = gate(await kvOf(name), "range", 1);
    const opening = openDocStore(held.db, v3);
    await held.arrived(2);
    // The other handle hears the rebuilding catalog over a channel; sync makes it read it now.
    await kv.sync();
    expect(await codeOf(old.queryIds({ index: "byU" }))).toBe("schema");
    held.release();
    await opening;
    await kv.sync();
    expect((await old.queryIds({ index: "byU", eq: ["dup"] })).ids).toEqual(["d000"]);
  });
});

describe("names that Object.prototype also has", () => {
  it.each(["constructor", "toString", "__proto__"])("refuses %s as a collection or index name with schema, and ignores it in drop", async (name) => {
    const kv = await kvOf();
    const docs = collection<Doc>();
    for (const s of [
      defineSchema({ version: 1, collections: { [name]: docs } }),
      defineSchema({ version: 1, collections: { docs: docs.index(name, "a") } }),
    ]) {
      expect(await codeOf(openDocStore(kv, s))).toBe("schema");
    }
    // A literal key, unlike the computed one above, sets the prototype of collections.
    expect(await codeOf(openDocStore(kv, defineSchema({ version: 1, collections: { __proto__: docs, docs } })))).toBe("schema");
    const v1 = defineSchema({ version: 1, collections: { docs: docs.index("byA", "a") }, drop: [name] });
    await (await openDocStore(kv, v1)).collection("docs").put({ id: "x", a: 1 });
    const c = (await openDocStore(kv, { ...v1, version: 2 })).collection("docs");
    expect((await c.queryIds({ index: "byA" })).ids).toEqual(["x"]);
  });
});

describe("a null text field", () => {
  it("gives an entry with no words, which a read finds and a match does not", async () => {
    type Note = { id: string; at: number; title?: string | null };
    const v1 = defineSchema({ version: 1, collections: { notes: collection<Note>().text("search", "at", "title") } });
    const notes = (await openDocStore(await kvOf(), v1)).collection("notes");
    await notes.putMany([{ id: "a", at: 1, title: null }, { id: "b", at: 2, title: "milk" }, { id: "c", at: 3 }]);
    expect((await notes.queryIds({ index: "search" })).ids).toEqual(["a", "b"]);
    expect((await notes.queryIds({ index: "search", match: "milk" })).ids).toEqual(["b"]);
  });
});

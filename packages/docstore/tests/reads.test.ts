import { CorruptDatabaseError, type Db } from "@opfs-lsm/kv";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { defineSchema, openDocStore } from "../src/index.js";
import { concat, rowPrefix, type CollectionId } from "../src/keys.js";
import type { QueryInput, Scalar } from "../src/schema.js";
import { asQuery, checkQuery, datasetArb, queryArb, schema, type Doc, type DocQuery, type Docs } from "./docs.js";
import { codeOf, freshName, openKv } from "./harness.js";
import { stored } from "./oracle.js";

const open: Db[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((kv) => kv.close()));
});

async function docs(): Promise<{ kv: Db; c: Docs }> {
  const kv = await openKv(freshName());
  open.push(kv);
  return { kv, c: (await openDocStore(kv, schema)).collection("docs") };
}

describe("get and getMany", () => {
  it("returns the stored form, undefined for a missing id, and getMany in the order asked", async () => {
    const { c } = await docs();
    await c.putMany([
      { id: "x", a: -0, b: undefined },
      { id: "y", a: "y" },
    ]);
    expect(await c.get("x")).toEqual({ id: "x", a: 0 });
    expect(await c.get("nope")).toBeUndefined();
    expect(await c.getMany(["y", "nope", "x"])).toEqual([{ id: "y", a: "y" }, undefined, { id: "x", a: 0 }]);
  });

  it("throws document for a bad id", async () => {
    const { c } = await docs();
    expect(await codeOf(c.get(""))).toBe("document");
    expect(await codeOf(c.getMany(["a", "\ud800"]))).toBe("document");
  });
});

describe("query matches a brute-force filter and sort", () => {
  it("for every index kind and the rows: the set, its order, reverse, paging, count and queryIds", async () => {
    await expect(
      fc.assert(
        fc.asyncProperty(
          datasetArb,
          fc.array(fc.tuple(queryArb, fc.integer({ min: 1, max: 12 })), { minLength: 1, maxLength: 6 }),
          async (dataset, queries) => {
            const kv = await openKv(freshName());
            try {
              const c = (await openDocStore(kv, schema)).collection("docs");
              await c.putMany(dataset);
              const all = dataset.map(stored);
              for (const [{ index, q }, pageSize] of queries) {
                await checkQuery(c, all, index, q, pageSize);
              }
            } finally {
              await kv.close();
            }
          },
        ),
        { numRuns: 60 },
      ),
    ).resolves.toBeUndefined();
  });
});

describe("order", () => {
  it("sorts string values by UTF-8 bytes, a U+0000 continuation after the string that stops there", async () => {
    const { c } = await docs();
    await c.putMany(["b", "aa", "a\u0000b", "a", ""].map((a, i) => ({ id: `${i}`, a })));
    const values = async (q: DocQuery) => (await c.query(q)).docs.map((d) => d.a);
    expect(await values({ index: "one" })).toEqual(["", "a", "a\u0000b", "aa", "b"]);
    expect(await values({ index: "one", reverse: true })).toEqual(["b", "aa", "a\u0000b", "a", ""]);
    expect(await values(asQuery({ index: "one", startsWith: "a" }))).toEqual(["a", "a\u0000b", "aa"]);
  });

  it("returns a value holding U+0000 for gt on its prefix, and not for eq or lte on it", async () => {
    const { c } = await docs();
    await c.putMany([
      { id: "1", a: "a" },
      { id: "2", a: "a\u0000b" },
    ]);
    const ids = async (q: DocQuery) => (await c.queryIds(q)).ids;
    expect(await ids({ index: "one", eq: ["a"] })).toEqual(["1"]);
    expect(await ids({ index: "one", lte: "a" })).toEqual(["1"]);
    expect(await ids({ index: "one", gt: "a" })).toEqual(["2"]);
  });

  it("orders null, false, true, numbers ascending with -0 equal to 0, then strings", async () => {
    const { c } = await docs();
    const values: Scalar[] = ["a", 1, true, -1, "", 0.5, false, -0, null];
    await c.putMany(values.map((a, i) => ({ id: `${i}`, a })));
    expect((await c.query({ index: "one" })).docs.map((d) => d.a)).toEqual([null, false, true, -1, 0, 0.5, 1, "", "a"]);
    expect((await c.queryIds({ index: "one", eq: [0] })).ids).toEqual(["7"]);
  });
});

describe("text search", () => {
  const titles: Doc[] = [
    { id: "1", a: 1, t: "Buy milk" },
    { id: "2", a: 2, t: "buy MILKSHAKE" },
    { id: "3", a: 3, t: "milk buyer" },
    { id: "4", a: 4, t: "Bacon" },
  ];
  const hits = async (c: Docs, q: DocQuery) => (await c.queryIds(q)).ids;

  it("keeps entries where every typed word starts a word of the text, ignoring case", async () => {
    const { c } = await docs();
    await c.putMany(titles);
    expect(await hits(c, { index: "search", match: "bu mi" })).toEqual(["1", "2", "3"]);
    expect(await hits(c, { index: "search", match: "milk" })).toEqual(["1", "2", "3"]);
    expect(await hits(c, { index: "search", match: "ilk" })).toEqual([]);
    expect(await hits(c, { index: "search", match: "BUY" })).toEqual(["1", "2", "3"]);
  });

  it("orders and pages matches by the index's on field, forward and reverse", async () => {
    const { c } = await docs();
    await c.putMany(titles);
    expect(await hits(c, { index: "search", match: "milk", reverse: true })).toEqual(["3", "2", "1"]);
    const first = await c.queryIds({ index: "search", match: "milk", reverse: true, limit: 2 });
    expect(first.ids).toEqual(["3", "2"]);
    const second = await c.queryIds({ index: "search", match: "milk", reverse: true, limit: 2, after: first.next });
    expect(second).toEqual({ ids: ["1"] });
    expect(await c.count({ index: "search", match: "milk", gte: 2 })).toBe(2);
  });

  it("throws query for a match with no words, and scans every text entry in order without match", async () => {
    const { c } = await docs();
    await c.putMany([...titles, { id: "5", a: 0, t: "" }, { id: "6", a: 5 }]);
    expect(await codeOf(c.query({ index: "search", match: "  ,. " }))).toBe("query");
    expect(await codeOf(c.query({ index: "search", match: "" }))).toBe("query");
    expect(await hits(c, { index: "search" })).toEqual(["5", "1", "2", "3", "4"]);
  });

  it("gives a document whose text path is missing no entry", async () => {
    const { c } = await docs();
    await c.putMany([{ id: "1", a: 1 }, { id: "2", a: 2, t: "milk" }]);
    expect(await c.count({ index: "search" })).toBe(1);
  });

  it("matches the new words and not the old ones after modify changes the text", async () => {
    const { c } = await docs();
    await c.putMany(titles);
    await c.modify("4", (d) => ({ ...d, t: "Buy eggs" }));
    expect(await hits(c, { index: "search", match: "bacon" })).toEqual([]);
    expect(await hits(c, { index: "search", match: "eg" })).toEqual(["4"]);
  });

  it("restricts a search to one eq group of a compound text index", async () => {
    type Note = { id: string; owner: string; updatedAt: number; body: string };
    const kv = await openKv(freshName());
    open.push(kv);
    const notes = (
      await openDocStore(
        kv,
        defineSchema<{ notes: Note }>()({
          version: 1,
          collections: { notes: { search: { on: ["owner", "updatedAt"], text: "body" } } },
        }),
      )
    ).collection("notes");
    await notes.putMany([
      { id: "1", owner: "ann", updatedAt: 2, body: "quarterly report" },
      { id: "2", owner: "bob", updatedAt: 1, body: "report draft" },
      { id: "3", owner: "ann", updatedAt: 1, body: "replies" },
      { id: "4", owner: "ann", updatedAt: 3, body: "lunch" },
    ]);
    const page = await notes.query({ index: "search", eq: ["ann"], match: "rep", reverse: true });
    expect(page.docs.map((d) => d.id)).toEqual(["1", "3"]);
  });
});

describe("malformed queries", () => {
  it.each<[string, QueryInput]>([
    ["gt with gte", { index: "one", gt: 1, gte: 1 }],
    ["startsWith with a bound", { index: "one", startsWith: "a", lt: "b" }],
    ["more eq values than components", { index: "one", eq: [1, 2] }],
    ["a bound after a full eq", { index: "two", eq: [1, 2], gt: 0 }],
    ["a NaN bound", { index: "one", gt: Number.NaN }],
    ["match on a sorted index", { index: "one", match: "x" }],
    ["match on the rows", { match: "x" }],
    ["a non-string id bound", { gt: 1 }],
    ["limit 0", { index: "one", limit: 0 }],
    ["a fractional limit", { limit: 1.5 }],
  ])("throws query for %s, from query, queryIds and count", async (_, q) => {
    const { c } = await docs();
    expect(await codeOf(c.query(asQuery(q)))).toBe("query");
    expect(await codeOf(c.queryIds(asQuery(q)))).toBe("query");
    expect(await codeOf(c.count(asQuery(q)))).toBe("query");
  });

  it("throws schema for an index this schema does not declare", async () => {
    const { c } = await docs();
    expect(await codeOf(c.query(asQuery({ index: "nope" })))).toBe("schema");
  });
});

describe("cursors", () => {
  it("throws cursor for an after from another eq group, past the range, or not a cursor", async () => {
    const { c } = await docs();
    await c.putMany([
      { id: "1", a: "x", b: 1 },
      { id: "2", a: "x", b: 2 },
      { id: "3", a: "y", b: 1 },
    ]);
    const { next } = await c.query({ index: "two", eq: ["x"], limit: 1 });
    expect((await c.queryIds({ index: "two", eq: ["x"], after: next })).ids).toEqual(["2"]);
    expect(await codeOf(c.query({ index: "two", eq: ["y"], after: next }))).toBe("cursor");
    expect(await codeOf(c.query({ index: "two", eq: ["x"], gt: 1, after: next }))).toBe("cursor");
    expect(await codeOf(c.query({ index: "one", after: next }))).toBe("cursor");
    expect(await codeOf(c.query({ index: "two", after: "%%" as never }))).toBe("cursor");
  });
});

describe("the read bracket", () => {
  it("throws CorruptDatabaseError when an entry points at a missing row and the catalog did not change", async () => {
    const { kv, c } = await docs();
    await c.put({ id: "1", a: 1 });
    await kv.delete(concat(rowPrefix(1 as CollectionId), new TextEncoder().encode("1")));
    await expect(c.query({ index: "one" })).rejects.toBeInstanceOf(CorruptDatabaseError);
  });
});

import { CorruptDatabaseError, prefixBound, type Db } from "@opfs-lsm/kv";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { collection, defineSchema, openDocStore, type Cursor } from "../src/index.js";
import { concat, encodeCursor, rowPrefix, type CollectionId } from "../src/keys.js";
import type { Json, QueryInput, Scalar } from "../src/schema.js";
import { asQuery, checkQuery, datasetArb, queryArb, schema, type Doc, type DocQuery, type Docs } from "./docs.js";
import { codeOf, freshName, openKv, storedPrefix } from "./harness.js";
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

describe("a list in eq on a multi index", () => {
  it("returns a document once when it holds several listed tags, forward and reverse, paged by any size", async () => {
    const tags = ["p", "q", "r"];
    const docArb = fc.uniqueArray(
      fc.record({ id: fc.constantFrom("a", "b", "c", "d", "e", "f"), b: fc.constantFrom(0, 1, 2), tags: fc.subarray(tags) }),
      { selector: (d) => d.id },
    );
    const queryArb = fc.record({
      index: fc.constant("tags"),
      eq: fc.subarray(tags, { minLength: 1 }).map((list) => [list]),
      reverse: fc.boolean(),
      bound: fc.constantFrom({}, { gte: 1 }, { lt: 2 }, { gt: 0, lte: 1 }),
    });
    await expect(
      fc.assert(
        fc.asyncProperty(docArb, queryArb, fc.integer({ min: 1, max: 4 }), async (dataset, { bound, ...q }, pageSize) => {
          const kv = await openKv(freshName());
          try {
            const c = (await openDocStore(kv, schema)).collection("docs");
            await c.putMany(dataset);
            await checkQuery(c, dataset.map(stored), "tags", { ...q, ...bound }, pageSize);
          } finally {
            await kv.close();
          }
        }),
        { numRuns: 100 },
      ),
    ).resolves.toBeUndefined();
  });
});

describe("queryEntries", () => {
  it("gives each entry the values of by, in by order, the ones eq fixed included", async () => {
    const { c } = await docs();
    await c.putMany([
      { id: "x", a: "p", b: 2, tags: ["t", "u"], u: 9 },
      { id: "y", a: "p", b: 1, tags: ["t"] },
      { id: "z", a: "q", b: 0 },
    ]);
    expect((await c.queryEntries({ index: "two", eq: ["p"] })).entries).toEqual([
      { id: "y", values: ["p", 1] },
      { id: "x", values: ["p", 2] },
    ]);
    expect((await c.queryEntries({ index: "tags", eq: ["t"], reverse: true })).entries).toEqual([
      { id: "x", values: ["t", 2] },
      { id: "y", values: ["t", 1] },
    ]);
    expect((await c.queryEntries({ index: "uniq" })).entries).toEqual([{ id: "x", values: [9] }]);
    expect((await c.queryEntries({ index: "two", eq: ["r"] })).entries).toEqual([]);
  });
});

describe("an index with include", () => {
  type Issue = {
    id: string;
    project: string;
    status: string;
    updatedAt: number;
    title?: string | undefined;
    number?: number;
    labels?: string[];
    meta?: { readonly [key: string]: Json };
  };
  const plain = collection<Issue>().index("byProject", ["project", "updatedAt"]).index("byLabel", ["labels[]", "updatedAt"]);
  const covering = defineSchema({
    version: 1,
    collections: {
      plain: plain,
      issues: plain
        .index("list", ["project", "updatedAt"], { include: ["title", "number", "meta"] })
        .index("labelled", ["labels[]", "updatedAt"], { include: ["title"] }),
    },
  });
  const issues: Issue[] = [
    { id: "a", project: "p", status: "open", updatedAt: 3, title: "Crash", number: 1, meta: { x: [1, null] } },
    { id: "b", project: "p", status: "done", updatedAt: 1, title: "Typo", number: 2, labels: ["ui", "docs"] },
    { id: "c", project: "p", status: "open", updatedAt: 2, number: 3, labels: ["ui"] },
    { id: "d", project: "q", status: "open", updatedAt: 0, title: "Other", number: 4 },
  ];

  async function store() {
    const kv = await openKv(freshName());
    open.push(kv);
    const s = await openDocStore(kv, covering);
    await s.collection("issues").putMany(issues);
    await s.collection("plain").putMany(issues);
    return { issues: s.collection("issues"), plain: s.collection("plain") };
  }

  it("returns each entry's included fields the document has, in index order, under eq, a bound, reverse and paging", async () => {
    const { issues: c } = await store();
    expect((await c.queryEntries({ index: "list", eq: ["p"] })).entries).toStrictEqual([
      { id: "b", values: ["p", 1], fields: { title: "Typo", number: 2 } },
      { id: "c", values: ["p", 2], fields: { number: 3 } },
      { id: "a", values: ["p", 3], fields: { title: "Crash", number: 1, meta: { x: [1, null] } } },
    ]);
    expect((await c.queryEntries({ index: "list", eq: ["p"], gte: 2, reverse: true })).entries.map((e) => e.fields)).toStrictEqual([
      { title: "Crash", number: 1, meta: { x: [1, null] } },
      { number: 3 },
    ]);
    const first = await c.queryEntries({ index: "list", limit: 2 });
    expect(first.entries.map((e) => [e.id, e.fields.number])).toStrictEqual([["b", 2], ["c", 3]]);
    const second = await c.queryEntries({ index: "list", limit: 2, after: first.next });
    expect(second.entries.map((e) => [e.id, e.fields.number])).toStrictEqual([["a", 1], ["d", 4]]);
    expect(second.next).toBeUndefined();
  });

  it("gives a multi index's entries the fields once per element", async () => {
    const { issues: c } = await store();
    expect((await c.queryEntries({ index: "labelled" })).entries).toStrictEqual([
      { id: "b", values: ["docs", 1], fields: { title: "Typo" } },
      { id: "b", values: ["ui", 1], fields: { title: "Typo" } },
      { id: "c", values: ["ui", 2], fields: {} },
    ]);
  });

  it("follows a put, a modify and a delete that change only an included field", async () => {
    const { issues: c } = await store();
    const fields = async () => (await c.queryEntries({ index: "list", eq: ["p"] })).entries.map((e) => [e.id, e.fields]);
    await c.put({ ...issues[0]!, title: "Crash on start" });
    await c.modify("c", (d) => ({ ...d, title: "Slow", number: 30 }));
    await c.modify("b", (d) => ({ ...d, title: undefined }));
    expect(await fields()).toStrictEqual([
      ["b", { number: 2 }],
      ["c", { title: "Slow", number: 30 }],
      ["a", { title: "Crash on start", number: 1, meta: { x: [1, null] } }],
    ]);
    await c.delete("c");
    expect((await fields()).map(([id]) => id)).toStrictEqual(["b", "a"]);
    expect((await c.queryEntries({ index: "labelled" })).entries.map((e) => e.values)).toStrictEqual([["docs", 1], ["ui", 1]]);
  });

  it("gives no fields to the entries of an index without include, or to the rows", async () => {
    const { issues: c } = await store();
    for (const e of [
      ...(await c.queryEntries({ index: "byProject" })).entries,
      ...(await c.queryEntries({ index: "byLabel" })).entries,
      ...(await c.queryEntries({})).entries,
    ]) {
      expect(Object.keys(e)).toStrictEqual(["id", "values"]);
    }
  });

  it("throws CorruptDatabaseError for an entry whose value is not a JSON object, and only when that entry is on the page", async () => {
    const kv = await openKv(freshName());
    open.push(kv);
    const c = (await openDocStore(kv, covering)).collection("issues");
    await c.putMany(issues.slice(0, 2));
    const keys: Uint8Array[] = [];
    for await (const e of kv.range(prefixBound(await storedPrefix(kv, "issues", "list")))) keys.push(e.key);
    await kv.put(keys[1]!, new TextEncoder().encode("[1]"));
    const first = await c.queryEntries({ index: "list", limit: 1 });
    expect(first.entries.map((e) => e.id)).toStrictEqual(["b"]);
    expect(first.next).toBeDefined();
    await expect(c.queryEntries({ index: "list" })).rejects.toThrow(CorruptDatabaseError);
  });

  it("returns the included fields and the own values of each entry for a list in eq, decoding none past the limit", async () => {
    const { issues: c } = await store();
    expect((await c.queryEntries({ index: "list", eq: [["q", "p"]], limit: 3 })).entries).toStrictEqual([
      { id: "d", values: ["q", 0], fields: { title: "Other", number: 4 } },
      { id: "b", values: ["p", 1], fields: { title: "Typo", number: 2 } },
      { id: "c", values: ["p", 2], fields: { number: 3 } },
    ]);
    expect((await c.queryEntries({ index: "list", eq: [["q", "p"]], reverse: true, limit: 1 })).entries).toStrictEqual([
      { id: "a", values: ["p", 3], fields: { title: "Crash", number: 1, meta: { x: [1, null] } } },
    ]);
  });

  it("decodes the fields of a merged page only for the entries it returns", async () => {
    const kv = await openKv(freshName());
    open.push(kv);
    const c = (await openDocStore(kv, covering)).collection("issues");
    await c.putMany(issues);
    const keys: Uint8Array[] = [];
    for await (const e of kv.range(prefixBound(await storedPrefix(kv, "issues", "list")))) keys.push(e.key);
    // The entries in key order: p/1 b, p/2 c, p/3 a, q/0 d. In the order of the query, d is first and c third.
    await kv.put(keys[1]!, new TextEncoder().encode("[1]"));
    const q = { index: "list", eq: [["q", "p"]] } as const;
    const first = await c.queryEntries({ ...q, limit: 2 });
    expect(first.entries.map((e) => e.id)).toStrictEqual(["d", "b"]);
    expect(first.next).toBeDefined();
    await expect(c.queryEntries({ ...q, limit: 3 })).rejects.toThrow(CorruptDatabaseError);
  });

  it("answers query, queryIds and count as the same index without include does", async () => {
    const { issues: c, plain } = await store();
    const qs = [{ eq: ["p"] }, { eq: ["p"], gt: 1, reverse: true }, { limit: 2, offset: 1 }] as const;
    // A cursor names its collection and index, so only whether one follows is compared.
    const page = <P extends { next?: unknown }>({ next, ...rest }: P) => ({ ...rest, more: next !== undefined });
    for (const q of qs) {
      expect(page(await c.query({ index: "list", ...q }))).toStrictEqual(page(await plain.query({ index: "byProject", ...q })));
      expect(page(await c.queryIds({ index: "list", ...q }))).toStrictEqual(page(await plain.queryIds({ index: "byProject", ...q })));
      expect(await c.count({ index: "list", ...q })).toBe(await plain.count({ index: "byProject", ...q }));
    }
    expect((await c.query({ index: "labelled", eq: ["ui"] })).docs).toStrictEqual((await plain.query({ index: "byLabel", eq: ["ui"] })).docs);
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

  it("keeps entries where every typed word occurs inside a word of the text, ignoring case", async () => {
    const { c } = await docs();
    await c.putMany(titles);
    expect(await hits(c, { index: "search", match: "bu mi" })).toEqual(["1", "2", "3"]);
    expect(await hits(c, { index: "search", match: "milk" })).toEqual(["1", "2", "3"]);
    expect(await hits(c, { index: "search", match: "ilk" })).toEqual(["1", "2", "3"]);
    expect(await hits(c, { index: "search", match: "HAKE uy" })).toEqual(["2"]);
    expect(await hits(c, { index: "search", match: "BUY" })).toEqual(["1", "2", "3"]);
  });

  it("does not match typed text that spans two words of the text", async () => {
    const { c } = await docs();
    await c.putMany(titles);
    expect(await hits(c, { index: "search", match: "ymilk" })).toEqual([]);
    expect(await hits(c, { index: "search", match: "kb" })).toEqual([]);
  });

  it("keeps combining marks inside a word and matches composed against decomposed text", async () => {
    const { c } = await docs();
    await c.putMany([
      { id: "1", a: 1, t: "हिन्दी" },
      { id: "2", a: 2, t: "ह न द" },
      { id: "3", a: 3, t: "cafe\u0301 noir" },
    ]);
    expect(await hits(c, { index: "search", match: "हिन्दी" })).toEqual(["1"]);
    expect(await hits(c, { index: "search", match: "café" })).toEqual(["3"]);
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
        defineSchema({
          version: 1,
          collections: { notes: collection<Note>().text("search", ["owner", "updatedAt"], "body") },
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

describe("a list in eq", () => {
  const rows: Doc[] = [
    { id: "1", a: "x", b: 3, tags: ["p", "q"] },
    { id: "2", a: "y", b: 1, tags: ["q"] },
    { id: "3", a: "x", b: 2, tags: ["p"] },
    { id: "4", a: "z", b: 2, tags: ["r", "q", "p"] },
    { id: "5", a: "y", b: 2 },
  ];

  it("merges the listed values in the order of the later components, then the id, whatever order they are listed in", async () => {
    const { c } = await docs();
    await c.putMany(rows);
    expect((await c.queryIds({ index: "two", eq: [["y", "x"]] })).ids).toEqual(["2", "3", "5", "1"]);
    expect((await c.queryIds({ index: "two", eq: [["x", "y", "x"]], reverse: true })).ids).toEqual(["1", "5", "3", "2"]);
    expect((await c.queryIds({ index: "two", eq: [["x", "y", "w"]], gt: 1, lt: 3 })).ids).toEqual(["3", "5"]);
    expect((await c.queryEntries({ index: "two", eq: [["y", "x"]], limit: 3 })).entries).toEqual([
      { id: "2", values: ["y", 1] },
      { id: "3", values: ["x", 2] },
      { id: "5", values: ["y", 2] },
    ]);
    expect((await c.query({ index: "two", eq: [["x", "y"]], gte: 2 })).docs.map((d) => d.id)).toEqual(["3", "5", "1"]);
    expect(await c.queryIds({ index: "two", eq: [["x"]] })).toEqual(await c.queryIds({ index: "two", eq: ["x"] }));
  });

  it("takes the cross product of several lists, one order by the fields after eq, then the id", async () => {
    const { c } = await docs();
    await c.putMany(rows);
    const q = { index: "two", eq: [["z", "x"], [3, 2, 0]] } as const;
    expect((await c.queryEntries(q)).entries).toEqual([
      { id: "1", values: ["x", 3] },
      { id: "3", values: ["x", 2] },
      { id: "4", values: ["z", 2] },
    ]);
    expect((await c.queryIds({ ...q, reverse: true })).ids).toEqual(["4", "3", "1"]);
    expect(await c.count(q)).toBe(3);
    expect((await c.queryIds({ index: "two", eq: ["y", [1, 2]] })).ids).toEqual(["2", "5"]);
    expect((await c.queryIds({ index: "tags", eq: [["p", "r"], [2]] })).ids).toEqual(["3", "4"]);
  });

  it("returns a multi index document once when it holds several listed values, with the entry of the first value in the scan", async () => {
    const { c } = await docs();
    await c.putMany(rows);
    const q = { index: "tags", eq: [["p", "q", "r"]] } as const;
    expect((await c.queryIds(q)).ids).toEqual(["2", "3", "4", "1"]);
    expect(await c.count(q)).toBe(4);
    expect((await c.queryEntries({ ...q, gte: 2 })).entries).toEqual([
      { id: "3", values: ["p", 2] },
      { id: "4", values: ["p", 2] },
      { id: "1", values: ["p", 3] },
    ]);
    expect((await c.queryEntries({ ...q, gte: 2, reverse: true })).entries).toEqual([
      { id: "1", values: ["q", 3] },
      { id: "4", values: ["r", 2] },
      { id: "3", values: ["p", 2] },
    ]);
    expect(await c.count({ ...q, offset: 1, limit: 2 })).toBe(2);
    expect((await c.queryIds({ ...q, offset: 2 })).ids).toEqual(["4", "1"]);
  });

  it.each([false, true])("visits every result once paging with limit 1, reverse %s", async (reverse) => {
    const { c } = await docs();
    await c.putMany(rows);
    for (const q of [
      { index: "two", eq: [["x", "y", "z"]] },
      { index: "tags", eq: [["p", "q", "r"]] },
      { index: "two", eq: [["x", "z"], [2, 3]] },
    ] as const) {
      const all = (await c.queryIds({ ...q, reverse })).ids;
      const seen: string[] = [];
      for (let after: Cursor | undefined; ; ) {
        const page = await c.queryIds({ ...q, reverse, limit: 1, ...(after ? { after } : {}) });
        seen.push(...page.ids);
        if (!page.next) break;
        after = page.next;
      }
      expect(seen).toEqual(all);
      expect(new Set(seen).size).toBe(all.length);
    }
  });

  it("resumes from a cursor of the query's own results, and throws cursor for one of a value it does not list", async () => {
    const { c } = await docs();
    await c.putMany(rows);
    const first = await c.queryIds({ index: "two", eq: [["x", "y"]], limit: 2 });
    expect(first.ids).toEqual(["2", "3"]);
    expect((await c.queryIds({ index: "two", eq: [["x", "y"]], after: first.next })).ids).toEqual(["5", "1"]);
    expect((await c.queryIds({ index: "two", eq: [["x", "z"]], after: first.next })).ids).toEqual(["4", "1"]);
    const back = await c.queryIds({ index: "two", eq: [["x", "y"]], reverse: true, limit: 1 });
    expect((await c.queryIds({ index: "two", eq: [["x", "y", "z"]], reverse: true, after: back.next })).ids).toEqual(["5", "4", "3", "2"]);
    for (const list of [["y", "z"], ["z"], []]) {
      expect(await codeOf(c.queryIds({ index: "two", eq: [list], after: first.next }))).toBe("cursor");
      expect(await codeOf(c.count({ index: "two", eq: [list], after: first.next }))).toBe("cursor");
    }
    expect(await codeOf(c.queryIds({ index: "two", eq: ["y"], after: first.next }))).toBe("cursor");
  });

  it("restricts a text search to the listed values", async () => {
    const { c } = await docs();
    await c.putMany([
      { id: "1", a: 1, t: "buy milk" },
      { id: "2", a: 2, t: "buy bacon" },
      { id: "3", a: 3, t: "milk" },
    ]);
    expect((await c.queryIds({ index: "search", eq: [[3, 1, 9]], match: "milk" })).ids).toEqual(["1", "3"]);
    expect(await c.count({ index: "search", eq: [[1, 2]], match: "buy", limit: 1 })).toBe(1);
  });

  it("returns nothing for an empty list, and reads the same through a view", async () => {
    const { c } = await docs();
    await c.putMany(rows);
    expect(await c.query({ index: "two", eq: [[]] })).toEqual({ docs: [] });
    expect(await c.queryEntries({ index: "two", eq: [[]], limit: 1 })).toEqual({ entries: [] });
    expect(await c.queryIds({ index: "two", eq: ["x", []] })).toEqual({ ids: [] });
    expect(await c.count({ index: "two", eq: [[]] })).toBe(0);
    // No result of such a query exists, so no cursor belongs to it.
    const { next } = await c.queryIds({ index: "two", eq: [["x"]], limit: 1 });
    await expect(c.queryIds({ index: "two", eq: [[]], after: next! })).rejects.toMatchObject({ code: "cursor" });
    expect(await c.view(async (snap) => (await snap.queryIds({ index: "two", eq: [["x", "z"]] })).ids)).toEqual(["3", "4", "1"]);
  });

  it("counts a page of the merge without repeats as the sum of its ranges", async () => {
    const { c } = await docs();
    await c.putMany(rows);
    const eq = [["x", "y", "z"]] as const;
    expect(await c.count({ index: "two", eq })).toBe(5);
    expect(await c.count({ index: "two", eq, offset: 4 })).toBe(1);
    expect(await c.count({ index: "two", eq, offset: 9 })).toBe(0);
    expect(await c.count({ index: "two", eq, offset: 1, limit: 2 })).toBe(2);
    expect(await c.count({ index: "two", eq, offset: 4, limit: 3 })).toBe(1);
  });

  it("throws query for a list on the rows or a unique index, a nested list, too many combinations, and every error of a query without lists", async () => {
    const { c } = await docs();
    const many = (n: number) => Array.from({ length: n }, (_, i) => i);
    const queries: [string, QueryInput][] = [
      ["a list on the rows", { eq: [["a"]] }],
      ["a list on a unique index", { index: "uniq", eq: [[1]] }],
      ["a non-array eq", { index: "one", eq: "a" as never }],
      ["a nested list", { index: "one", eq: [[["a"]]] as never }],
      ["65 values", { index: "one", eq: [many(65)] }],
      ["72 combinations", { index: "two", eq: [many(9), many(8)] }],
      ["a value that is not an index value", { index: "one", eq: [[Number.NaN]] }],
      ["more slots than components", { index: "one", eq: [["a"], ["b"]] }],
      ["a bound after a full eq", { index: "two", eq: [["a"], [1]], gt: 1 }],
      ["gt with gte", { index: "two", eq: [["a"]], gt: 1, gte: 1 }],
      ["match on a sorted index", { index: "one", eq: [[1]], match: "x" }],
      ["an empty list with a bound that is not an index value", { index: "two", eq: [[]], gt: Number.NaN }],
    ];
    for (const [, q] of queries) {
      expect(await codeOf(c.query(asQuery(q)))).toBe("query");
      expect(await codeOf(c.queryIds(asQuery(q)))).toBe("query");
      expect(await codeOf(c.queryEntries(asQuery(q)))).toBe("query");
      expect(await codeOf(c.count(asQuery(q)))).toBe("query");
    }
    expect(await c.count({ index: "one", eq: [[...many(64), ...many(64)]] })).toBe(0);
    expect(await c.count({ index: "two", eq: [many(8), many(8)] })).toBe(0);
    expect(await c.count({ index: "two", eq: [many(100), []] })).toBe(0);
  });

  it("throws cursor for a cursor outside the prefix, of another index, or cut inside a component", async () => {
    const { c } = await docs();
    await c.putMany(rows);
    const { next } = await c.query({ index: "two", eq: ["x"], limit: 1 });
    const other = await c.query({ index: "one", limit: 1 });
    const bad = [
      { index: "two", eq: [[1], ["y"]], after: next },
      { index: "two", eq: [["y"]], after: next },
      { index: "two", eq: [["x"]], after: other.next },
      { index: "two", eq: [["x"]], after: "%%" as Cursor },
      { index: "tags", eq: [["p"]], after: encodeCursor(Uint8Array.of(0x64, 0, 1, 0x03)) },
    ];
    for (const q of bad) {
      expect(await codeOf(c.queryIds(asQuery(q)))).toBe("cursor");
      expect(await codeOf(c.count(asQuery(q)))).toBe("cursor");
    }
    expect(await codeOf(c.query({ index: "two", eq: [["x"]], after: "ZAAB" as Cursor }))).toBe("cursor");
  });

  it("throws cursor for a cursor outside the bound, as a query without lists does", async () => {
    const { c } = await docs();
    await c.putMany(rows);
    const first = await c.queryIds({ index: "two", eq: [["x", "y"]], limit: 1 });
    expect(first.ids).toEqual(["2"]);
    expect((await c.queryIds({ index: "two", eq: [["x", "y"]], gte: 1, after: first.next })).ids).toEqual(["3", "5", "1"]);
    for (const bound of [{ lt: 1 }, { gt: 2 }, { gt: 1 }]) {
      const q = { index: "two", eq: [["x", "y"]], ...bound, after: first.next };
      expect(await codeOf(c.queryIds(asQuery(q)))).toBe("cursor");
      expect(await codeOf(c.count(asQuery(q)))).toBe("cursor");
    }
  });

  it("resumes under a listed value longer than the cursor's own, and past an entry whose key is as long as a key can be", async () => {
    const { c } = await docs();
    const long = "y".repeat(4000);
    await c.putMany([
      { id: "1", a: "x", b: "b".repeat(5000) },
      { id: "2", a: long, b: "zzz" },
      { id: "3", a: "x", b: "zzzz" },
    ]);
    for (const reverse of [false, true]) {
      const q = { index: "two", eq: [["x", long]], reverse } as const;
      const all = (await c.queryIds(q)).ids;
      expect(all).toEqual(reverse ? ["3", "2", "1"] : ["1", "2", "3"]);
      const first = await c.queryIds({ ...q, limit: 1 });
      expect((await c.queryIds({ ...q, after: first.next! })).ids).toEqual(all.slice(1));
      expect(await c.count({ ...q, after: first.next! })).toBe(2);
    }

    const { c: d } = await docs();
    // The index prefix, the string's tag and terminator, and the id take 7 bytes of the key.
    await d.putMany([
      { id: "1", a: "s".repeat(8185) },
      { id: "2", a: "t" },
    ]);
    const first = await d.queryIds({ index: "one", limit: 1 });
    expect(first.ids).toEqual(["1"]);
    expect((await d.queryIds({ index: "one", after: first.next! })).ids).toEqual(["2"]);
    const last = await d.queryIds({ index: "one", reverse: true, limit: 1 });
    expect((await d.queryIds({ index: "one", reverse: true, after: last.next! })).ids).toEqual(["1"]);
  });

  it("gives kv's error for a value too long for a key", async () => {
    const { c } = await docs();
    const long = "s".repeat(300_000);
    await expect(c.queryIds({ index: "one", eq: [[long]] })).rejects.toThrow("key longer");
    await expect(c.count({ index: "one", eq: [[long, long]] })).rejects.toThrow("key longer");
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
    ["a negative offset", { index: "one", offset: -1 }],
    ["a fractional offset", { offset: 0.5 }],
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

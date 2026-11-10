import { describe, expect, it } from "vitest";
import { bind, encodeCatalog, normalizeSchema, reconcile, type BoundCollection } from "../src/catalog.js";
import { diffEntries, encodeDoc, entriesOf } from "../src/derive.js";
import { DocStoreError } from "../src/errors.js";
import { encodeKey } from "../src/keys.js";
import type { JsonDoc, Scalar } from "../src/schema.js";

const utf8 = new TextEncoder();
const EMPTY = new Uint8Array(0);

function coll(indexes: Record<string, object>): BoundCollection {
  const declared = normalizeSchema({ version: 1, collections: { c: indexes } });
  const r = reconcile(undefined, declared);
  if (r.kind !== "write") throw new Error("a fresh catalog is written");
  return bind(encodeCatalog(r.catalog), r.catalog, declared).collections.get("c")!;
}

const prefixOf = (c: BoundCollection, index: string) => c.maintained.find((p) => p.name === index)!.target.prefix;

const entry = (c: BoundCollection, index: string, values: Scalar[], id = "1") => ({
  key: encodeKey(prefixOf(c, index), values, utf8.encode(id)),
  value: EMPTY,
});

function entries(c: BoundCollection, doc: JsonDoc, side: "next" | "stored" = "next") {
  const { id, doc: stored } = encodeDoc(doc);
  return entriesOf(c, utf8.encode(id), stored, side);
}

function codeOf(f: () => unknown): string {
  try {
    f();
  } catch (err) {
    if (err instanceof DocStoreError) return err.code;
    throw err;
  }
  return "no error";
}

describe("entries come from the stored JSON", () => {
  it("reads -0 as 0, NaN and Infinity as null, and a toJSON value as its JSON form", () => {
    const doc = { id: "1", n: -0, nan: Number.NaN, inf: Number.POSITIVE_INFINITY, when: { toJSON: () => "2024" } };
    const c = coll({ n: { on: "n" }, nan: { on: "nan" }, inf: { on: "inf" }, when: { on: "when" } });
    expect(encodeDoc(doc as unknown as JsonDoc).doc).toEqual({ id: "1", n: 0, nan: null, inf: null, when: "2024" });
    expect(entries(c, doc as unknown as JsonDoc)).toEqual([
      entry(c, "n", [0]),
      entry(c, "nan", [null]),
      entry(c, "inf", [null]),
      entry(c, "when", ["2024"]),
    ]);
  });

  it("gives no entry for a missing or undefined path, and indexes null", () => {
    const c = coll({ a: { on: "a" }, b: { on: "b" }, nx: { on: "n.x" }, proto: { on: ["a", "toString"] } });
    expect(entries(c, { id: "1", a: null, b: undefined })).toEqual([entry(c, "a", [null])]);
  });

  it("orders a compound entry by its paths, nested ones included", () => {
    const c = coll({ x: { on: ["owner", "meta.at"] } });
    expect(entries(c, { id: "1", owner: "ann", meta: { at: 5 } })).toEqual([entry(c, "x", ["ann", 5])]);
  });

  it("rejects a document that is not a JSON object or has a bad id", () => {
    expect(codeOf(() => encodeDoc([] as unknown as JsonDoc))).toBe("document");
    expect(codeOf(() => encodeDoc({ id: 1 } as unknown as JsonDoc))).toBe("document");
    expect(codeOf(() => encodeDoc({ id: "\ud800" }))).toBe("document");
  });
});

describe("multi index", () => {
  const c = coll({ tags: { on: ["tags", "at"], multi: true } });

  it("has one entry per distinct element, followed by the other paths", () => {
    expect(entries(c, { id: "1", tags: ["a", "b", "a"], at: 2 })).toEqual([entry(c, "tags", ["a", 2]), entry(c, "tags", ["b", 2])]);
  });

  it("treats a scalar as a one-element array and an empty array as no entry", () => {
    expect(entries(c, { id: "1", tags: "a", at: 2 })).toEqual([entry(c, "tags", ["a", 2])]);
    expect(entries(c, { id: "1", tags: [], at: 2 })).toEqual([]);
  });

  it("accepts 1,000 distinct elements and rejects 1,001", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);
    expect(entries(c, { id: "1", tags: many(1000), at: 0 })).toHaveLength(1000);
    expect(codeOf(() => entries(c, { id: "1", tags: many(1001), at: 0 }))).toBe("document");
  });
});

describe("unique and text entries", () => {
  it("keys a unique entry by its values alone and stores the id as its value", () => {
    const c = coll({ slug: { on: "slug", unique: true } });
    expect(entries(c, { id: "doc-1", slug: "hi" })).toEqual([
      { key: encodeKey(prefixOf(c, "slug"), ["hi"]), value: utf8.encode("doc-1") },
    ]);
  });

  it("stores the lowercased words of the text, a space before each", () => {
    const c = coll({ search: { on: "at", text: "title" } });
    const [e] = entries(c, { id: "1", at: 3, title: "Buy MILK, then bread!" });
    expect(e!.key).toEqual(entry(c, "search", [3]).key);
    expect(new TextDecoder().decode(e!.value)).toBe(" buy milk then bread");
    expect(entries(c, { id: "1", at: 3 })).toEqual([]);
  });
});

describe("values an index cannot hold", () => {
  const cases: [string, object, JsonDoc][] = [
    ["an object", { on: "a" }, { id: "1", a: { b: 1 } }],
    ["an array on a non-multi index", { on: "a" }, { id: "1", a: [1] }],
    ["a non-scalar element of a multi index", { on: "tags", multi: true }, { id: "1", tags: ["a", { b: 1 }] }],
    ["a non-string text", { on: "at", text: "title" }, { id: "1", at: 1, title: 5 }],
    ["a key longer than 8 KiB", { on: "a" }, { id: "1", a: "x".repeat(9000) }],
  ];

  it.each(cases)("throws document for %s being written", (_, index, doc) => {
    expect(codeOf(() => entries(coll({ x: index }), doc))).toBe("document");
  });

  it.each(cases)("gives no entry for %s already stored", (_, index, doc) => {
    const c = coll({ x: index, byId: { on: "id" } });
    expect(entries(c, doc, "stored")).toEqual([entry(c, "byId", ["1"])]);
  });
});

describe("diffEntries", () => {
  const id = "1";
  const derive = (c: BoundCollection, doc: JsonDoc) => entriesOf(c, utf8.encode(id), encodeDoc(doc).doc, "next");

  it("writes nothing for a change no index covers", () => {
    const c = coll({ a: { on: "a" }, b: { on: "b" } });
    expect(diffEntries(derive(c, { id, a: 1, b: 2, x: 1 }), derive(c, { id, a: 1, b: 2, x: 2 }))).toEqual({ remove: [], write: [] });
  });

  it("removes and writes only the entries of the changed field", () => {
    const c = coll({ a: { on: "a" }, b: { on: "b" } });
    expect(diffEntries(derive(c, { id, a: 1, b: 2 }), derive(c, { id, a: 1, b: 3 }))).toEqual({
      remove: [entry(c, "b", [2]).key],
      write: [entry(c, "b", [3])],
    });
  });

  it("rewrites a text entry whose words changed under the same key", () => {
    const c = coll({ search: { on: "at", text: "title" } });
    const { remove, write } = diffEntries(derive(c, { id, at: 1, title: "old" }), derive(c, { id, at: 1, title: "new" }));
    expect(remove).toEqual([]);
    expect(write.map((e) => new TextDecoder().decode(e.value))).toEqual([" new"]);
  });

  it("removes only the entry of a removed tag", () => {
    const c = coll({ tags: { on: "tags", multi: true } });
    expect(diffEntries(derive(c, { id, tags: ["a", "b"] }), derive(c, { id, tags: ["b"] }))).toEqual({
      remove: [entry(c, "tags", ["a"]).key],
      write: [],
    });
  });
});

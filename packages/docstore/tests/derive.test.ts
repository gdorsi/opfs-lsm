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
  const catalog = reconcile(undefined, declared)!;
  return bind(encodeCatalog(catalog), catalog, declared).collections.get("c")!;
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
    const c = coll({ n: { by: "n" }, nan: { by: "nan" }, inf: { by: "inf" }, when: { by: "when" } });
    expect(encodeDoc(doc as unknown as JsonDoc).doc).toEqual({ id: "1", n: 0, nan: null, inf: null, when: "2024" });
    expect(entries(c, doc as unknown as JsonDoc)).toEqual([
      entry(c, "n", [0]),
      entry(c, "nan", [null]),
      entry(c, "inf", [null]),
      entry(c, "when", ["2024"]),
    ]);
  });

  it("gives no entry for a missing or undefined path, and indexes null", () => {
    const c = coll({ a: { by: "a" }, b: { by: "b" }, nx: { by: "n.x" }, proto: { by: ["a", "toString"] } });
    expect(entries(c, { id: "1", a: null, b: undefined })).toEqual([entry(c, "a", [null])]);
  });

  it("orders a compound entry by its paths, nested ones included", () => {
    const c = coll({ x: { by: ["owner", "meta.at"] } });
    expect(entries(c, { id: "1", owner: "ann", meta: { at: 5 } })).toEqual([entry(c, "x", ["ann", 5])]);
  });

  it("rejects a document that is not a JSON object or has a bad id", () => {
    expect(codeOf(() => encodeDoc([] as unknown as JsonDoc))).toBe("document");
    expect(codeOf(() => encodeDoc({ id: 1 } as unknown as JsonDoc))).toBe("document");
    expect(codeOf(() => encodeDoc({ id: "\ud800" }))).toBe("document");
  });
});

describe("multi index", () => {
  const c = coll({ tags: { by: ["tags[]", "at"] } });

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
    const c = coll({ slug: { by: "slug", unique: true } });
    expect(entries(c, { id: "doc-1", slug: "hi" })).toEqual([
      { key: encodeKey(prefixOf(c, "slug"), ["hi"]), value: utf8.encode("doc-1") },
    ]);
  });

  it("stores the lowercased words of the text, a space before each", () => {
    const c = coll({ search: { by: "at", text: "title" } });
    const [e] = entries(c, { id: "1", at: 3, title: "Buy MILK, then bread!" });
    expect(e!.key).toEqual(entry(c, "search", [3]).key);
    expect(new TextDecoder().decode(e!.value)).toBe("buy milk then bread");
    expect(entries(c, { id: "1", at: 3 })).toEqual([]);
  });
});

describe("values an index cannot hold", () => {
  const cases: [string, object, JsonDoc][] = [
    ["an object", { by: "a" }, { id: "1", a: { b: 1 } }],
    ["an array on a non-multi index", { by: "a" }, { id: "1", a: [1] }],
    ["a non-scalar element of a multi index", { by: "tags[]" }, { id: "1", tags: ["a", { b: 1 }] }],
    ["a string with a lone surrogate", { by: "a" }, { id: "1", a: "x\ud800" }],
    ["a multi element with a lone surrogate", { by: "tags[]" }, { id: "1", tags: ["a", "\udc00"] }],
    ["a non-string text", { by: "at", text: "title" }, { id: "1", at: 1, title: 5 }],
    ["a key longer than 8 KiB", { by: "a" }, { id: "1", a: "x".repeat(9000) }],
  ];

  it.each(cases)("throws document for %s being written", (_, index, doc) => {
    expect(codeOf(() => entries(coll({ x: index }), doc))).toBe("document");
  });

  it.each(cases)("gives no entry for %s already stored", (_, index, doc) => {
    const c = coll({ x: index, byId: { by: "id" } });
    expect(entries(c, doc, "stored")).toEqual([entry(c, "byId", ["1"])]);
  });
});

describe("diffEntries", () => {
  const id = "1";
  const derive = (c: BoundCollection, doc: JsonDoc) => entriesOf(c, utf8.encode(id), encodeDoc(doc).doc, "next");

  it("writes nothing for a change no index covers", () => {
    const c = coll({ a: { by: "a" }, b: { by: "b" } });
    expect(diffEntries(derive(c, { id, a: 1, b: 2, x: 1 }), derive(c, { id, a: 1, b: 2, x: 2 }))).toEqual({ remove: [], write: [] });
  });

  it("removes and writes only the entries of the changed field", () => {
    const c = coll({ a: { by: "a" }, b: { by: "b" } });
    expect(diffEntries(derive(c, { id, a: 1, b: 2 }), derive(c, { id, a: 1, b: 3 }))).toEqual({
      remove: [entry(c, "b", [2]).key],
      write: [entry(c, "b", [3])],
    });
  });

  it("rewrites a text entry whose words changed under the same key", () => {
    const c = coll({ search: { by: "at", text: "title" } });
    const { remove, write } = diffEntries(derive(c, { id, at: 1, title: "old" }), derive(c, { id, at: 1, title: "new" }));
    expect(remove).toEqual([]);
    expect(write.map((e) => new TextDecoder().decode(e.value))).toEqual(["new"]);
  });

  it("writes every entry of a new document and removes none, and the reverse for a deleted one", () => {
    const c = coll({ a: { by: "a" }, tags: { by: "tags[]" } });
    const doc = derive(c, { id, a: 1, tags: ["x", "y"] });
    expect(diffEntries([], doc)).toEqual({ remove: [], write: doc });
    expect(diffEntries(doc, [])).toEqual({ remove: doc.map((e) => e.key), write: [] });
  });

  it("removes only the entry of a removed tag", () => {
    const c = coll({ tags: { by: "tags[]" } });
    expect(diffEntries(derive(c, { id, tags: ["a", "b"] }), derive(c, { id, tags: ["b"] }))).toEqual({
      remove: [entry(c, "tags", ["a"]).key],
      write: [],
    });
  });
});

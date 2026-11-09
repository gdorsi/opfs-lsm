import { describe, expect, it } from "vitest";
import type { BoundCollection, CompiledSpec, IndexPlan } from "../src/catalog.js";
import { diffEntries, encodeDoc, entriesOf } from "../src/derive.js";
import { DocStoreError } from "../src/errors.js";
import { encodeKey, indexPrefix, rowPrefix, type CollectionId, type DocId, type IndexId } from "../src/keys.js";
import type { JsonDoc, Scalar } from "../src/schema.js";

const C = 9 as CollectionId;
const utf8 = new TextEncoder();
const EMPTY = new Uint8Array(0);

function plan(id: number, spec: CompiledSpec): IndexPlan {
  const kind = spec.kind === "text" ? "text" : spec.unique ? "unique" : "sorted";
  return {
    name: `i${id}`,
    id: id as IndexId,
    state: { kind: "ready" },
    spec,
    target: { kind, prefix: indexPrefix(C, id as IndexId), rowPrefix: rowPrefix(C), arity: spec.on.length },
  };
}
const sorted = (id: number, ...on: string[]) =>
  plan(id, { kind: "sorted", on: on.map((p) => p.split(".")), unique: false, multi: false });
const coll = (...maintained: IndexPlan[]): BoundCollection => ({ name: "c", id: C, maintained });

const entry = (index: number, values: Scalar[], id = "1") => ({
  key: encodeKey(indexPrefix(C, index as IndexId), values, utf8.encode(id)),
  value: EMPTY,
});

function entries(c: BoundCollection, doc: JsonDoc, side: "next" | "stored" = "next") {
  const { id, doc: stored } = encodeDoc(doc);
  return entriesOf(c, id, stored, side);
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
    const c = coll(sorted(1, "n"), sorted(2, "nan"), sorted(3, "inf"), sorted(4, "when"));
    expect(encodeDoc(doc as unknown as JsonDoc).doc).toEqual({ id: "1", n: 0, nan: null, inf: null, when: "2024" });
    expect(entries(c, doc as unknown as JsonDoc)).toEqual([entry(1, [0]), entry(2, [null]), entry(3, [null]), entry(4, ["2024"])]);
  });

  it("gives no entry for a missing or undefined path, and indexes null", () => {
    const c = coll(sorted(1, "a"), sorted(2, "b"), sorted(3, "n.x"), sorted(4, "a", "toString"));
    expect(entries(c, { id: "1", a: null, b: undefined })).toEqual([entry(1, [null])]);
  });

  it("orders a compound entry by its paths, nested ones included", () => {
    const c = coll(sorted(1, "owner", "meta.at"));
    expect(entries(c, { id: "1", owner: "ann", meta: { at: 5 } })).toEqual([entry(1, ["ann", 5])]);
  });

  it("rejects a document that is not a JSON object or has a bad id", () => {
    expect(codeOf(() => encodeDoc([] as unknown as JsonDoc))).toBe("document");
    expect(codeOf(() => encodeDoc({ id: 1 } as unknown as JsonDoc))).toBe("document");
    expect(codeOf(() => encodeDoc({ id: "\ud800" }))).toBe("document");
  });
});

describe("multi index", () => {
  const tags = plan(1, { kind: "sorted", on: [["tags"], ["at"]], unique: false, multi: true });

  it("has one entry per distinct element, followed by the other paths", () => {
    expect(entries(coll(tags), { id: "1", tags: ["a", "b", "a"], at: 2 })).toEqual([entry(1, ["a", 2]), entry(1, ["b", 2])]);
  });

  it("treats a scalar as a one-element array and an empty array as no entry", () => {
    expect(entries(coll(tags), { id: "1", tags: "a", at: 2 })).toEqual([entry(1, ["a", 2])]);
    expect(entries(coll(tags), { id: "1", tags: [], at: 2 })).toEqual([]);
  });

  it("accepts 1,000 distinct elements and rejects 1,001", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);
    expect(entries(coll(tags), { id: "1", tags: many(1000), at: 0 })).toHaveLength(1000);
    expect(codeOf(() => entries(coll(tags), { id: "1", tags: many(1001), at: 0 }))).toBe("document");
  });
});

describe("unique and text entries", () => {
  it("keys a unique entry by its values alone and stores the id as its value", () => {
    const u = plan(1, { kind: "sorted", on: [["slug"]], unique: true, multi: false });
    expect(entries(coll(u), { id: "doc-1", slug: "hi" })).toEqual([
      { key: encodeKey(indexPrefix(C, 1 as IndexId), ["hi"]), value: utf8.encode("doc-1") },
    ]);
  });

  it("stores the lowercased words of the text, a space before each", () => {
    const t = plan(1, { kind: "text", on: [["at"]], text: ["title"] });
    const [e] = entries(coll(t), { id: "1", at: 3, title: "Buy MILK, then bread!" });
    expect(e!.key).toEqual(entry(1, [3]).key);
    expect(new TextDecoder().decode(e!.value)).toBe(" buy milk then bread");
    expect(entries(coll(t), { id: "1", at: 3 })).toEqual([]);
  });
});

describe("values an index cannot hold", () => {
  const multi = plan(2, { kind: "sorted", on: [["tags"]], unique: false, multi: true });
  const text = plan(3, { kind: "text", on: [["at"]], text: ["title"] });
  const cases: [string, IndexPlan, JsonDoc][] = [
    ["an object", sorted(1, "a"), { id: "1", a: { b: 1 } }],
    ["an array on a non-multi index", sorted(1, "a"), { id: "1", a: [1] }],
    ["a non-scalar element of a multi index", multi, { id: "1", tags: ["a", { b: 1 }] }],
    ["a non-string text", text, { id: "1", at: 1, title: 5 }],
    ["a key longer than 8 KiB", sorted(1, "a"), { id: "1", a: "x".repeat(9000) }],
  ];

  it.each(cases)("throws document for %s being written", (_, p, doc) => {
    expect(codeOf(() => entries(coll(p), doc))).toBe("document");
  });

  it.each(cases)("gives no entry for %s already stored", (_, p, doc) => {
    expect(entries(coll(p, sorted(9, "id")), doc, "stored")).toEqual([entry(9, ["1"])]);
  });
});

describe("diffEntries", () => {
  const id = "1" as DocId;
  const derive = (c: BoundCollection, doc: JsonDoc) => entriesOf(c, id, encodeDoc(doc).doc, "next");

  it("writes nothing for a change no index covers", () => {
    const c = coll(sorted(1, "a"), sorted(2, "b"));
    expect(diffEntries(derive(c, { id, a: 1, b: 2, x: 1 }), derive(c, { id, a: 1, b: 2, x: 2 }))).toEqual({ remove: [], write: [] });
  });

  it("removes and writes only the entries of the changed field", () => {
    const c = coll(sorted(1, "a"), sorted(2, "b"));
    expect(diffEntries(derive(c, { id, a: 1, b: 2 }), derive(c, { id, a: 1, b: 3 }))).toEqual({
      remove: [entry(2, [2]).key],
      write: [entry(2, [3])],
    });
  });

  it("rewrites a text entry whose words changed under the same key", () => {
    const c = coll(plan(1, { kind: "text", on: [["at"]], text: ["title"] }));
    const { remove, write } = diffEntries(derive(c, { id, at: 1, title: "old" }), derive(c, { id, at: 1, title: "new" }));
    expect(remove).toEqual([]);
    expect(write.map((e) => new TextDecoder().decode(e.value))).toEqual([" new"]);
  });

  it("removes only the entry of a removed tag", () => {
    const c = coll(plan(1, { kind: "sorted", on: [["tags"]], unique: false, multi: true }));
    expect(diffEntries(derive(c, { id, tags: ["a", "b"] }), derive(c, { id, tags: ["b"] }))).toEqual({
      remove: [entry(1, ["a"]).key],
      write: [],
    });
  });
});

import { encodeTuple } from "@opfs-lsm/kv/tuple";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { bind, encodeCatalog, normalizeSchema, reconcile, type BoundCollection } from "../src/catalog.js";
import { diffEntries, docEncoder, entriesOf } from "../src/derive.js";
import { DocStoreError } from "../src/errors.js";
import type { JsonDoc, Scalar } from "../src/schema.js";

const utf8 = new TextEncoder();
const EMPTY = new Uint8Array(0);
const encodeDoc = (doc: JsonDoc) => docEncoder("c", undefined)([doc])[0]!;

function coll(indexes: Record<string, object>): BoundCollection {
  const declared = normalizeSchema({ version: 1, collections: { c: { indexes } } } as never);
  const { catalog } = reconcile(undefined, declared)!;
  return bind(encodeCatalog(catalog), catalog, declared).collections.get("c")!;
}

const prefixOf = (c: BoundCollection, index: string) => c.maintained.find((p) => p.name === index)!.target.prefix;

const entry = (c: BoundCollection, index: string, values: Scalar[], id = "1") => ({
  key: encodeTuple(values, prefixOf(c, index), utf8.encode(id)),
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

describe("covering index", () => {
  const fieldsOf = (c: BoundCollection, doc: JsonDoc) => entries(c, doc).map((e) => JSON.parse(new TextDecoder().decode(e.value)) as unknown);

  it("holds the JSON of the included fields the document has, in the order `include` lists them", () => {
    const c = coll({ x: { by: "a", include: ["t", "n", "missing", "list"] } });
    const [e] = entries(c, { id: "1", a: 1, t: "x", list: [1, { k: null }], n: 2, other: true });
    expect(new TextDecoder().decode(e!.value)).toBe('{"t":"x","n":2,"list":[1,{"k":null}]}');
  });

  it("copies a field named __proto__ like any other, wherever `include` lists it", () => {
    for (const include of [["__proto__", "t"], ["t", "__proto__"], ["t", "__proto__", "n"]]) {
      const c = coll({ x: { by: "a", include } });
      const doc = JSON.parse('{"id":"1","a":1,"t":"x","n":2,"__proto__":{"y":1}}') as JsonDoc;
      const [fields] = fieldsOf(c, doc) as [Record<string, unknown>];
      expect(Object.entries(fields)).toEqual(include.map((f) => [f, f === "__proto__" ? { y: 1 } : f === "t" ? "x" : 2]));
    }
  });

  it("keeps every value it made while it makes more, of any length and with any character", () => {
    const c = coll({ x: { by: "a", include: ["t"] } });
    // Short and long, ASCII and not, across more bytes than one shared buffer holds.
    const texts = Array.from({ length: 400 }, (_, i) => (i % 7 === 0 ? "é€😀\u0000" : "t").repeat(1 + ((i * 37) % 300)) + i);
    const made = texts.map((t, i) => entries(c, { id: String(i), a: i, t })[0]!.value);
    expect(made.map((v) => (JSON.parse(new TextDecoder().decode(v)) as { t: string }).t)).toEqual(texts);
    expect(made.map((v) => [...v])).toEqual(texts.map((t) => [...utf8.encode(JSON.stringify({ t }))]));
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
    expect(entries(c, { id: "1", tags: [...many(1000), "t0"], at: 0 })).toHaveLength(1000);
    expect(codeOf(() => entries(c, { id: "1", tags: many(1001), at: 0 }))).toBe("document");
  });
});

describe("unique and text entries", () => {
  it("keys a unique entry by its values alone and stores the id as its value", () => {
    const c = coll({ slug: { by: "slug", unique: true } });
    expect(entries(c, { id: "doc-1", slug: "hi" })).toEqual([
      { key: encodeTuple(["hi"], prefixOf(c, "slug")), value: utf8.encode("doc-1") },
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
    ["an array after the first field of a multi index", { by: ["tags[]", "at"] }, { id: "1", tags: ["a"], at: [1, 2] }],
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

describe("the entries of one document", () => {
  // diffEntries needs this: with a key twice in one list, its short route would remove a key the document still has.
  it("have distinct keys, whatever the document repeats", () => {
    const c = coll({
      tags: { by: ["tags[]", "at"] },
      tag: { by: "tags[]" },
      at: { by: "at" },
      both: { by: ["at", "title"] },
      slug: { by: "at", unique: true },
      search: { by: "at", text: "title" },
    });
    const scalar = fc.oneof(
      fc.constantFrom<Scalar>(0, -0, 1, 0.5, "", "0", "1", "a", "a\0", "A", true, false, null),
      fc.string({ maxLength: 2 }).filter((v) => v.isWellFormed()),
      fc.integer({ min: -2, max: 2 }),
    );
    fc.assert(
      fc.property(fc.array(scalar, { maxLength: 12 }), scalar, fc.constantFrom("", "a a", "A a"), (tags, at, title) => {
        const keys = entries(c, { id: "1", tags, at, title }).map((e) => e.key.join(","));
        expect(new Set(keys).size).toBe(keys.length);
      }),
      { numRuns: 2000 },
    );
  });
});

describe("diffEntries against a model", () => {
  const VALUES = [EMPTY, Uint8Array.of(1), Uint8Array.of(1, 2)];
  const hex = (key: Uint8Array) => Array.from(key, (b) => b.toString(16).padStart(2, "0")).join("");
  const entryOf = (key: Uint8Array, v: number) => ({ key, value: VALUES[v]! });

  /** The definition: write what is new or has another value, in the order of `after`; remove what `after` lacks, in the order of `before`. */
  function model(before: { key: Uint8Array; value: Uint8Array }[], after: { key: Uint8Array; value: Uint8Array }[]) {
    const old = new Map(before.map((e) => [hex(e.key), e]));
    const now = new Set(after.map((e) => hex(e.key)));
    return {
      remove: before.filter((e) => !now.has(hex(e.key))).map((e) => e.key),
      write: after.filter((e) => {
        const was = old.get(hex(e.key));
        return was === undefined || hex(was.value) !== hex(e.value);
      }),
    };
  }

  /** Keys that share bytes with each other and with the index prefix, so they collide and differ late. */
  const keyArb = fc.array(fc.constantFrom(0, 1, 2, 0xff), { minLength: 1, maxLength: 4 }).map((bytes) => Uint8Array.of(0x64, 0, 1, 3, ...bytes));

  it.each([
    ["lists of up to 40 entries", 40],
    ["lists of up to 18 entries", 18],
  ])("matches it for %s, in any order", (_, max) => {
    fc.assert(
      fc.property(
        fc.uniqueArray(keyArb, { maxLength: max * 2, selector: hex }).chain((pool) =>
          fc.record({
            before: fc.shuffledSubarray(pool, { maxLength: Math.min(max, pool.length) }),
            after: fc.shuffledSubarray(pool, { maxLength: Math.min(max, pool.length) }),
            bv: fc.array(fc.nat(2), { minLength: pool.length, maxLength: pool.length }),
            av: fc.array(fc.nat(2), { minLength: pool.length, maxLength: pool.length }),
            pool: fc.constant(pool),
          }),
        ),
        ({ before, after, bv, av, pool }) => {
          const at = (k: (typeof pool)[number]) => pool.indexOf(k);
          const b = before.map((k) => entryOf(k, bv[at(k)]!));
          const a = after.map((k) => entryOf(k, av[at(k)]!));
          expect(diffEntries(b, a)).toEqual(model(b, a));
        },
      ),
      { numRuns: 1000 },
    );
  });

  it.each([1, 15, 16, 17, 32, 33, 60])("finds the one changed entry among %i, whichever side of the 16 entry route it is", (n) => {
    const keys = Array.from({ length: n }, (_, i) => Uint8Array.of(0x64, 0, 1, 3, i >> 8, i & 0xff));
    const before = keys.map((k) => entryOf(k, 0));
    for (const i of [0, n >> 1, n - 1]) {
      const after = keys.map((k, j) => entryOf(j === i ? Uint8Array.of(...k, 9) : k, 0));
      expect(diffEntries(before, after)).toEqual({ remove: [keys[i]!], write: [after[i]!] });
      const valued = keys.map((k, j) => entryOf(k, j === i ? 1 : 0));
      expect(diffEntries(before, valued)).toEqual({ remove: [], write: [valued[i]!] });
    }
    expect(diffEntries(before, [...before].reverse())).toEqual({ remove: [], write: [] });
  });
});

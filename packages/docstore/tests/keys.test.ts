import { encodeTuple } from "@opfs-lsm/kv/tuple";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DocStoreError } from "../src/errors.js";
import {
  compareBytes,
  encodeCursor,
  entryRowKey,
  keyId,
  idBytes,
  indexPrefix,
  rowPrefix,
  scanPlan,
  textValue,
  type DocId,
  type CollectionId,
  type IndexId,
  type IndexTarget,
  type ScanTarget,
} from "../src/keys.js";
import type { QueryInput, Scalar } from "../src/schema.js";
import { compareCodePoints, compareScalar, compareTuple, denseScalarArb, stringArb } from "./order.js";

const RUNS = Number(process.env.DOCSTORE_KEYS_RUNS ?? 300);
const EMPTY = new Uint8Array(0);
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();
const COLLECTION = 0x0107 as CollectionId;
const INDEX = 3 as IndexId;
const hex = (key: Uint8Array) => Array.from(key, (b) => b.toString(16).padStart(2, "0")).join("");

type Stored = { readonly values: Scalar[]; readonly id: string };
type Ix = { readonly kind: "sorted" | "unique" | "text"; readonly arity: number; readonly entries: Stored[] };

const indexTarget = (ix: Ix): IndexTarget => ({
  kind: ix.kind,
  prefix: indexPrefix(COLLECTION, INDEX),
  rowPrefix: rowPrefix(COLLECTION),
  arity: ix.arity,
});

function entryOf(ix: Ix, e: Stored): { key: Uint8Array; value: Uint8Array } {
  const prefix = indexPrefix(COLLECTION, INDEX);
  return ix.kind === "unique"
    ? { key: encodeTuple(e.values, prefix), value: utf8.encode(e.id) }
    : { key: encodeTuple(e.values, prefix, utf8.encode(e.id)), value: EMPTY };
}

function dedupe<T>(items: readonly T[], keyOf: (t: T) => Uint8Array): T[] {
  return [...new Map(items.map((t) => [hex(keyOf(t)), t])).values()];
}

/** What kv's `range` returns for `plan`'s range over `entries`. */
function kvScan(entries: readonly { key: Uint8Array; value: Uint8Array }[], q: QueryInput, target: ScanTarget) {
  const { range } = scanPlan(target, q).ranges[0]!;
  const hits = [...entries]
    .sort((a, b) => compareBytes(a.key, b.key))
    .filter((e) => compareBytes(e.key, range.start!) >= 0 && compareBytes(e.key, range.endExclusive!) < 0);
  return range.reverse ? hits.reverse() : hits;
}

function boundOk(v: Scalar, q: QueryInput): boolean {
  if (q.gt !== undefined && !(compareScalar(v, q.gt) > 0)) return false;
  if (q.gte !== undefined && !(compareScalar(v, q.gte) >= 0)) return false;
  if (q.lt !== undefined && !(compareScalar(v, q.lt) < 0)) return false;
  if (q.lte !== undefined && !(compareScalar(v, q.lte) <= 0)) return false;
  if (q.startsWith !== undefined) return typeof v === "string" && v.startsWith(q.startsWith);
  return true;
}

const codePointPrefixes = (s: string) => {
  const cps = Array.from(s);
  return Array.from({ length: cps.length + 1 }, (_, n) => cps.slice(0, n).join(""));
};

function boundArb(value: fc.Arbitrary<Scalar>, prefix: fc.Arbitrary<string>): fc.Arbitrary<QueryInput> {
  return fc.oneof(
    fc.constant({}),
    fc.record({ gt: value }),
    fc.record({ gte: value }),
    fc.record({ lt: value }),
    fc.record({ lte: value }),
    fc.record({ gt: value, lt: value }),
    fc.record({ gte: value, lte: value }),
    fc.record({ gt: value, lte: value }),
    fc.record({ gte: value, lt: value }),
    fc.record({ startsWith: prefix }),
  );
}

function queryArb(ix: Ix): fc.Arbitrary<QueryInput> {
  const valueAt = (pos: number): fc.Arbitrary<Scalar> =>
    ix.entries.length > 0 ? fc.oneof(fc.constantFrom(...ix.entries.map((e) => e.values[pos]!)), denseScalarArb) : denseScalarArb;
  const strings = ix.entries.flatMap((e) => e.values.filter((v): v is string => typeof v === "string"));
  const prefix = strings.length > 0 ? fc.oneof(fc.constantFrom(...strings.flatMap(codePointPrefixes)), stringArb) : stringArb;
  return fc.integer({ min: 0, max: ix.arity }).chain((k) => {
    const eq: fc.Arbitrary<Scalar[]> =
      ix.entries.length > 0
        ? fc.oneof(
            fc.constantFrom(...ix.entries).map((e) => e.values.slice(0, k)),
            fc.tuple(...Array.from({ length: k }, (_, i) => valueAt(i))),
          )
        : fc.tuple(...Array.from({ length: k }, (_, i) => valueAt(i)));
    const bound = k === ix.arity ? fc.constant({}) : boundArb(valueAt(k), prefix);
    return fc
      .record({ eq, bound, reverse: fc.boolean() })
      .map(({ eq, bound, reverse }) => ({ ...(k > 0 ? { eq } : {}), ...bound, reverse }));
  });
}

const ixArb: fc.Arbitrary<Ix> = fc
  .record({ kind: fc.constantFrom("sorted" as const, "unique" as const, "text" as const), arity: fc.integer({ min: 1, max: 3 }) })
  .chain(({ kind, arity }) =>
    fc
      .array(
        fc.record({
          values: fc.array(denseScalarArb, { minLength: arity, maxLength: arity }),
          id: stringArb.filter((s) => s !== ""),
        }),
        { maxLength: 30 },
      )
      .map((raw) => {
        const ix: Ix = { kind, arity, entries: [] };
        return { ...ix, entries: dedupe(raw, (e) => entryOf(ix, e).key) };
      }),
  );

describe("scanPlan", () => {
  it("selects exactly the index entries a brute-force filter selects, in order, forward and reverse, with and without after", () => {
    fc.assert(
      fc.property(
        ixArb.chain((ix) => fc.tuple(fc.constant(ix), queryArb(ix), fc.nat())),
        ([ix, q, pick]) => {
          const target = indexTarget(ix);
          const k = q.eq?.length ?? 0;
          const expected = ix.entries
            .filter((e) => e.values.slice(0, k).every((v, i) => compareScalar(v, q.eq![i] as Scalar) === 0))
            .filter((e) => k === ix.arity || boundOk(e.values[k]!, q))
            .sort((a, b) => compareTuple(a.values, b.values) || compareCodePoints(a.id, b.id));
          if (q.reverse) expected.reverse();
          const entries = ix.entries.map((e) => entryOf(ix, e));
          const hits = kvScan(entries, q, target);
          expect(hits.map((h) => hex(h.key))).toEqual(expected.map((e) => hex(entryOf(ix, e).key)));
          expect(hits.map((h) => fromUtf8.decode(entryRowKey(target, h.key, h.value).subarray(rowPrefix(COLLECTION).length)))).toEqual(expected.map((e) => e.id));
          if (hits.length === 0) return;
          const i = pick % hits.length;
          const rest = kvScan(entries, { ...q, after: encodeCursor(hits[i]!.key) }, target);
          expect(rest.map((h) => hex(h.key))).toEqual(hits.slice(i + 1).map((h) => hex(h.key)));
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("selects exactly the rows a brute-force filter selects, in id order, forward and reverse, with and without after", () => {
    const target: ScanTarget = { kind: "rows", prefix: rowPrefix(COLLECTION) };
    const rowsArb = fc.uniqueArray(stringArb.filter((s) => s !== ""), { maxLength: 30 });
    const caseArb = rowsArb.chain((ids) => {
      const id = ids.length > 0 ? fc.oneof(fc.constantFrom(...ids), stringArb) : stringArb;
      const prefix = ids.length > 0 ? fc.oneof(fc.constantFrom(...ids.flatMap(codePointPrefixes)), stringArb) : stringArb;
      const q = fc.oneof(
        id.map((x): QueryInput => ({ eq: [x] })),
        boundArb(id, prefix),
      );
      return fc.tuple(fc.constant(ids), q, fc.boolean(), fc.nat());
    });
    fc.assert(
      fc.property(caseArb, ([ids, bounds, reverse, pick]) => {
        const q = { ...bounds, reverse };
        const expected = ids
          .filter((id) => (q.eq ? id === q.eq[0] : boundOk(id, q)))
          .sort(compareCodePoints);
        if (reverse) expected.reverse();
        const entries = ids.map((id) => ({
          key: Uint8Array.from([...rowPrefix(COLLECTION), ...utf8.encode(id)]),
          value: EMPTY,
        }));
        const hits = kvScan(entries, q, target);
        expect(hits.map((h) => keyId(target, h.key))).toEqual(expected);
        if (hits.length === 0) return;
        const i = pick % hits.length;
        const rest = kvScan(entries, { ...q, after: encodeCursor(hits[i]!.key) }, target);
        expect(rest).toEqual(hits.slice(i + 1));
      }),
      { numRuns: RUNS },
    );
  });

  const two: ScanTarget = { kind: "sorted", prefix: indexPrefix(COLLECTION, INDEX), rowPrefix: rowPrefix(COLLECTION), arity: 2 };
  const code = (f: () => unknown) => {
    try {
      f();
    } catch (err) {
      return err instanceof DocStoreError ? err.code : err;
    }
    return "no error";
  };

  it.each<[string, QueryInput]>([
    ["gt with gte", { gt: 1, gte: 1 }],
    ["lt with lte", { lt: 1, lte: 1 }],
    ["startsWith with a bound", { startsWith: "a", lt: "b" }],
    ["more eq values than components", { eq: [1, 2, 3] }],
    ["a bound after a full eq", { eq: [1, 2], gte: 0 }],
    ["startsWith after a full eq", { eq: [1, 2], startsWith: "a" }],
    ["a NaN bound", { gt: Number.NaN }],
    ["an infinite eq value", { eq: [Number.POSITIVE_INFINITY] }],
    ["an object bound", { lt: {} as unknown as Scalar }],
    ["a bound with a lone surrogate", { gte: "a\ud800" }],
    ["startsWith with a lone surrogate", { startsWith: "\udfff" }],
    ["match on a sorted index", { match: "x" }],
  ])("rejects %s with code query", (_, q) => {
    expect(code(() => scanPlan(two, q))).toBe("query");
  });

  it("plans one range for a query without lists, and one per distinct combination of listed values, in the order of their prefixes", () => {
    const prefix = indexPrefix(COLLECTION, INDEX);
    expect(scanPlan(two, { eq: ["a"] })).toMatchObject({ ranges: [{ skip: encodeTuple(["a"], prefix).length }], repeats: false });
    const plan = scanPlan(two, { eq: [["b", "a", "b"], [2, 1]], reverse: true });
    const starts = [
      ["a", 1],
      ["a", 2],
      ["b", 1],
      ["b", 2],
    ].map((c) => hex(encodeTuple(c as Scalar[], prefix)));
    expect(plan.ranges.map((r) => hex(r.range.start!))).toEqual(starts);
    expect(plan.ranges.every((r) => r.range.reverse && r.skip === encodeTuple(["a", 1], prefix).length)).toBe(true);
    expect(scanPlan(two, { eq: [[]] }).ranges).toEqual([]);
  });

  it("flags repeats only for a list on the array field of a multi index", () => {
    const multi: ScanTarget = { ...two, multi: true };
    expect(scanPlan(multi, { eq: [["a", "b"]] }).repeats).toBe(true);
    expect(scanPlan(multi, { eq: [["a", "a"], [1, 2]] }).repeats).toBe(false);
    expect(scanPlan(multi, { eq: ["a", [1, 2]] }).repeats).toBe(false);
    expect(scanPlan(two, { eq: [["a", "b"]] }).repeats).toBe(false);
  });

  it("rejects a list on the rows, on a unique index, nested, and of more than 64 combinations with code query", () => {
    const rows: ScanTarget = { kind: "rows", prefix: rowPrefix(COLLECTION) };
    const many = (n: number) => Array.from({ length: n }, (_, i) => i);
    expect(code(() => scanPlan(rows, { eq: [["a"]] }))).toBe("query");
    expect(code(() => scanPlan({ ...two, kind: "unique" }, { eq: [[1]] }))).toBe("query");
    expect(code(() => scanPlan(two, { eq: [[[1]]] as never }))).toBe("query");
    expect(code(() => scanPlan(two, { eq: [many(65)] }))).toBe("query");
    expect(code(() => scanPlan(two, { eq: [many(9), many(8)] }))).toBe("query");
    expect(code(() => scanPlan(two, { eq: [many(8), many(8)] }))).toBe("no error");
  });

  it("rejects match with no words on a text index with code query", () => {
    const text: ScanTarget = { ...two, kind: "text" };
    expect(code(() => scanPlan(text, { match: "  ,. " }))).toBe("query");
    expect(code(() => scanPlan(text, { match: "x" }))).toBe("no error");
  });

  it("rejects a cursor from another eq group, past the upper bound, from another collection id, or not a cursor, with code cursor", () => {
    const key = (values: Scalar[], c = COLLECTION) => encodeTuple(values, indexPrefix(c, INDEX), utf8.encode("id"));
    const inA = encodeCursor(key(["a", 1]));
    expect(code(() => scanPlan(two, { eq: ["a"], after: inA }))).toBe("no error");
    expect(code(() => scanPlan(two, { eq: ["b"], after: inA }))).toBe("cursor");
    expect(code(() => scanPlan(two, { eq: ["a"], lt: 1, after: inA }))).toBe("cursor");
    expect(code(() => scanPlan(two, { eq: ["a"], after: encodeCursor(key(["a", 1], 0x0108 as CollectionId)) }))).toBe("cursor");
    expect(code(() => scanPlan(two, { after: "not a cursor!" as never }))).toBe("cursor");
  });
});

describe("idBytes and textValue", () => {
  const unit = fc.constantFrom("a", "Z", "0", "-", "\0", "é", "\u07ff", "日", "\u{ffff}", "😀", "\ud800", "\udfff");
  const stringOfAnyLength = fc.oneof(
    fc.string({ unit: "grapheme-ascii", maxLength: 40 }),
    fc.string({ unit, maxLength: 40 }),
    fc.constantFrom(0, 1, 340, 341, 1023, 1024, 1025, 1026, 3000).chain((n) => fc.string({ unit: fc.constantFrom("a", "é", "😀"), minLength: n, maxLength: n })),
  );

  it("idBytes is the UTF-8 of the id, lone surrogates as U+FFFD, for ids of any length", () => {
    fc.assert(
      fc.property(stringOfAnyLength, (id) => {
        expect(idBytes(id as DocId)).toEqual(utf8.encode(id));
      }),
      { numRuns: RUNS },
    );
  });

  it("hands out a buffer of its own, which a later call does not change", () => {
    const first = idBytes("abc" as DocId);
    const second = idBytes("xyz-longer" as DocId);
    expect(Array.from(first)).toEqual([0x61, 0x62, 0x63]);
    expect(first.buffer.byteLength).toBeGreaterThanOrEqual(3);
    expect(Array.from(second.subarray(0, 3))).toEqual([0x78, 0x79, 0x7a]);
    expect(Array.from(idBytes("é" as DocId))).toEqual([0xc3, 0xa9]);
    expect(Array.from(first)).toEqual([0x61, 0x62, 0x63]);
  });

  it("textValue is the lowercased words joined by one space, as UTF-8", () => {
    expect(fromUtf8.decode(textValue("  Hello, WORLD!  Ünï-cödé 日本 "))).toBe("hello world ünï cödé 日本");
    expect(textValue("")).toEqual(new Uint8Array(0));
    const long = Array.from({ length: 600 }, (_, i) => `word${i}`);
    expect(fromUtf8.decode(textValue(long.join(", ")))).toBe(long.join(" "));
    expect(textValue(long.join(" ")).length).toBe(long.join(" ").length);
    const wide = Array.from({ length: 400 }, () => "日本語").join(" ");
    expect(textValue(wide)).toEqual(utf8.encode(wide));
  });
});

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DocStoreError } from "../src/errors.js";
import {
  compareBytes,
  encodeCursor,
  encodeKey,
  entryId,
  indexPrefix,
  rowPrefix,
  scanPlan,
  type CollectionId,
  type IndexId,
  type ScanTarget,
} from "../src/keys.js";
import type { QueryInput, Scalar } from "../src/schema.js";
import { compareCodePoints, compareScalar, compareTuple, denseScalarArb, scalarArb, stringArb } from "./order.js";

const RUNS = Number(process.env.DOCSTORE_KEYS_RUNS ?? 300);
const EMPTY = new Uint8Array(0);
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();
const COLLECTION = 0x0107 as CollectionId;
const INDEX = 3 as IndexId;
const sign = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0);
const hex = (key: Uint8Array) => Array.from(key, (b) => b.toString(16).padStart(2, "0")).join("");

describe("value encoding", () => {
  it("byte order of encoded tuples equals the documented value order", () => {
    const tuple = fc.array(scalarArb, { maxLength: 3 });
    fc.assert(
      fc.property(tuple, tuple, (a, b) => {
        expect(sign(compareBytes(encodeKey(EMPTY, a), encodeKey(EMPTY, b)))).toBe(sign(compareTuple(a, b)));
      }),
      { numRuns: RUNS * 10 },
    );
  });

  it("orders null, false, true, numbers ascending with -0 equal to 0, then strings", () => {
    const values: Scalar[] = [null, false, true, -Number.MAX_VALUE, -1, -0.5, 0, 0.5, 1, Number.MAX_VALUE, "", "a"];
    const keys = values.map((v) => encodeKey(EMPTY, [v]));
    for (let i = 1; i < keys.length; i++) expect(compareBytes(keys[i - 1]!, keys[i]!)).toBeLessThan(0);
    expect(encodeKey(EMPTY, [-0])).toEqual(encodeKey(EMPTY, [0]));
  });

  it("orders strings by UTF-8 bytes, U+0000 inside a string after the string that stops there", () => {
    const sorted = ["b", "aa", "a\u0000b", "a", "", "\uffff", "😀"]
      .map((s) => ({ s, key: encodeKey(EMPTY, [s]) }))
      .sort((x, y) => compareBytes(x.key, y.key))
      .map((x) => x.s);
    expect(sorted).toEqual(["", "a", "a\u0000b", "aa", "b", "\uffff", "😀"]);
  });
});

type Stored = { readonly values: Scalar[]; readonly id: string };
type Ix = { readonly kind: "sorted" | "unique" | "text"; readonly arity: number; readonly entries: Stored[] };

const indexTarget = (ix: Ix): ScanTarget => ({
  kind: ix.kind,
  prefix: indexPrefix(COLLECTION, INDEX),
  rowPrefix: rowPrefix(COLLECTION),
  arity: ix.arity,
});

function entryOf(ix: Ix, e: Stored): { key: Uint8Array; value: Uint8Array } {
  const prefix = indexPrefix(COLLECTION, INDEX);
  return ix.kind === "unique"
    ? { key: encodeKey(prefix, e.values), value: utf8.encode(e.id) }
    : { key: encodeKey(prefix, e.values, utf8.encode(e.id)), value: EMPTY };
}

function dedupe<T>(items: readonly T[], keyOf: (t: T) => Uint8Array): T[] {
  return [...new Map(items.map((t) => [hex(keyOf(t)), t])).values()];
}

/** What kv's `range` returns for `plan`'s range over `entries`. */
function kvScan(entries: readonly { key: Uint8Array; value: Uint8Array }[], q: QueryInput, target: ScanTarget) {
  const { range } = scanPlan(target, q);
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
            .filter((e) => e.values.slice(0, k).every((v, i) => compareScalar(v, q.eq![i]!) === 0))
            .filter((e) => k === ix.arity || boundOk(e.values[k]!, q))
            .sort((a, b) => compareTuple(a.values, b.values) || compareCodePoints(a.id, b.id));
          if (q.reverse) expected.reverse();
          const entries = ix.entries.map((e) => entryOf(ix, e));
          const hits = kvScan(entries, q, target);
          expect(hits.map((h) => hex(h.key))).toEqual(expected.map((e) => hex(entryOf(ix, e).key)));
          expect(hits.map((h) => fromUtf8.decode(entryId(target, h.key, h.value)))).toEqual(expected.map((e) => e.id));
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
        expect(hits.map((h) => fromUtf8.decode(entryId(target, h.key, h.value)))).toEqual(expected);
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
    ["match on a sorted index", { match: "x" }],
  ])("rejects %s with code query", (_, q) => {
    expect(code(() => scanPlan(two, q))).toBe("query");
  });

  it("rejects match with no words on a text index with code query", () => {
    const text: ScanTarget = { ...two, kind: "text" };
    expect(code(() => scanPlan(text, { match: "  ,. " }))).toBe("query");
    expect(code(() => scanPlan(text, { match: "x" }))).toBe("no error");
  });

  it("rejects a cursor from another eq group, past the upper bound, from another collection id, or not a cursor, with code cursor", () => {
    const key = (values: Scalar[], c = COLLECTION) => encodeKey(indexPrefix(c, INDEX), values, utf8.encode("id"));
    const inA = encodeCursor(key(["a", 1]));
    expect(code(() => scanPlan(two, { eq: ["a"], after: inA }))).toBe("no error");
    expect(code(() => scanPlan(two, { eq: ["b"], after: inA }))).toBe("cursor");
    expect(code(() => scanPlan(two, { eq: ["a"], lt: 1, after: inA }))).toBe("cursor");
    expect(code(() => scanPlan(two, { eq: ["a"], after: encodeCursor(key(["a", 1], 0x0108 as CollectionId)) }))).toBe("cursor");
    expect(code(() => scanPlan(two, { after: "not a cursor!" as never }))).toBe("cursor");
  });
});

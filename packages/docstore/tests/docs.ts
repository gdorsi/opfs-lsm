import fc from "fast-check";
import { expect } from "vitest";
import { defineSchema, type Collection, type Cursor, type Query } from "../src/index.js";
import type { QueryInput, Scalar } from "../src/schema.js";
import { expected, type ModelIndex } from "./oracle.js";
import { denseScalarArb, stringArb } from "./order.js";

export type Doc = {
  id: string;
  a?: Scalar | undefined;
  b?: Scalar | undefined;
  tags?: Scalar[] | undefined;
  u?: Scalar | undefined;
  t?: string | undefined;
};

export const schema = defineSchema<{ docs: Doc }>()({
  version: 1,
  collections: {
    docs: {
      one: { on: "a" },
      two: { on: ["a", "b"] },
      tags: { on: ["tags", "b"], multi: true },
      uniq: { on: "u", unique: true },
      search: { on: "a", text: "t" },
    },
  },
});

export const MODEL: Record<string, ModelIndex> = {
  one: { kind: "sorted", on: ["a"] },
  two: { kind: "sorted", on: ["a", "b"] },
  tags: { kind: "multi", on: ["tags", "b"] },
  uniq: { kind: "unique", on: ["u"] },
  search: { kind: "text", on: ["a"], text: "t" },
};
export const ARITY: Record<string, number> = { one: 1, two: 2, tags: 2, uniq: 1, search: 1 };

export type Docs = Collection<Doc, (typeof schema)["collections"]["docs"]>;
export type DocQuery = Query<Doc, (typeof schema)["collections"]["docs"]>;

export const asQuery = (q: QueryInput) => q as DocQuery;

const WORDS = ["Buy", "milk", "MILKSHAKE", "buyer", "Bacon", "rép", "Ünï", "x1", "2024", ",", " ", "-"];
export const textArb = fc.array(fc.constantFrom(...WORDS), { maxLength: 5 }).map((ws) => ws.join(" "));
export const matchArb = fc
  .array(fc.constantFrom("bu", "BUY", "mi", "milk", "milks", "ba", "r", "ün", "x", "20", "q"), { minLength: 1, maxLength: 2 })
  .map((ws) => ws.join(" "));
export const idArb = stringArb.filter((s) => s !== "");

export const datasetArb = fc
  .tuple(
    fc.uniqueArray(
      fc.record(
        {
          id: idArb,
          a: fc.option(denseScalarArb, { nil: undefined }),
          b: fc.option(denseScalarArb, { nil: undefined }),
          tags: fc.option(fc.array(denseScalarArb, { maxLength: 4 }), { nil: undefined }),
          t: fc.option(textArb, { nil: undefined }),
        },
        { requiredKeys: ["id"] },
      ),
      { selector: (d) => d.id, maxLength: 25 },
    ),
    fc.uniqueArray(denseScalarArb, { selector: (v) => JSON.stringify(v), maxLength: 25 }),
  )
  .map(([ds, us]) => ds.map((d, i): Doc => (i < us.length ? { ...d, u: us[i] } : d)));

function boundArb(value: fc.Arbitrary<Scalar>): fc.Arbitrary<QueryInput> {
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
    fc.record({ startsWith: stringArb }),
  );
}

export const queryArb: fc.Arbitrary<{ index: string | undefined; q: QueryInput }> = fc
  .constantFrom(undefined, ...Object.keys(MODEL))
  .chain((index) => {
    const arity = index === undefined ? 1 : ARITY[index]!;
    const value = index === undefined ? idArb : denseScalarArb;
    return fc.integer({ min: 0, max: arity }).chain((k) =>
      fc
        .record({
          eq: fc.array(value, { minLength: k, maxLength: k }),
          bound: k === arity ? fc.constant({}) : boundArb(value),
          reverse: fc.boolean(),
          match: index === "search" ? fc.option(matchArb, { nil: undefined }) : fc.constant(undefined),
        })
        .map(({ eq, bound, reverse, match }) => ({
          index,
          q: {
            ...(index === undefined ? {} : { index }),
            ...(eq.length > 0 ? { eq } : {}),
            ...bound,
            ...(reverse ? { reverse } : {}),
            ...(match === undefined ? {} : { match }),
          },
        })),
    );
  });

/**
 * Check `query`, `queryIds` and `count` for `q` against a brute-force filter
 * and sort of `docs` (stored forms), then page through with `pageSize`.
 */
export async function checkQuery(
  c: Docs,
  docs: readonly Doc[],
  index: string | undefined,
  q: QueryInput,
  pageSize: number,
): Promise<void> {
  const want = expected(docs, index === undefined ? undefined : MODEL[index], q);
  const query = asQuery(q);
  expect((await c.queryIds(query)).ids).toEqual(want.map((h) => h.id));
  expect((await c.query(query)).docs).toEqual(want.map((h) => h.doc));
  expect(await c.count(query)).toBe(want.length);
  expect(await c.count(asQuery({ ...q, limit: pageSize }))).toBe(Math.min(pageSize, want.length));

  const paged: string[] = [];
  let pages = 0;
  for (let after: Cursor | undefined; ; ) {
    const page = await c.query(asQuery({ ...q, limit: pageSize, ...(after ? { after } : {}) }));
    pages++;
    paged.push(...page.docs.map((d) => d.id));
    if (page.next === undefined) break;
    expect(page.docs).toHaveLength(pageSize);
    after = page.next;
  }
  expect(paged).toEqual(want.map((h) => h.id));
  expect(pages).toBe(Math.max(1, Math.ceil(want.length / pageSize)));
}

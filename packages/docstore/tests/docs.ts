import fc from "fast-check";
import { expect } from "vitest";
import { collection, defineSchema, type Collection, type CountQuery, type Cursor, type Query } from "../src/index.js";
import type { QueryInput, Scalar } from "../src/schema.js";
import { expected, type ModelIndex } from "./oracle.js";
import { denseScalarArb, stringArb } from "./order.js";

export type Doc = {
  id: string;
  a?: Scalar | undefined;
  b?: Scalar | undefined;
  tags?: Scalar[] | undefined;
  u?: Scalar | undefined;
  t?: string | null | undefined;
  ut?: Scalar[] | undefined;
};

export const schema = defineSchema({
  version: 1,
  collections: {
    docs: collection<Doc>()
      .index("one", "a")
      .index("two", ["a", "b"])
      .index("tags", ["tags[]", "b"])
      .unique("uniq", "u")
      .text("search", "a", "t")
      .index("covered", ["b", "a"], { include: ["t", "tags", "u"] })
      .count("perA", "a")
      .count("perAB", ["a", "b"])
      .count("perTag", "tags[]"),
  },
});

export const MODEL: Record<string, ModelIndex> = {
  one: { kind: "sorted", on: ["a"] },
  two: { kind: "sorted", on: ["a", "b"] },
  tags: { kind: "multi", on: ["tags", "b"] },
  uniq: { kind: "unique", on: ["u"] },
  search: { kind: "text", on: ["a"], text: "t" },
  covered: { kind: "sorted", on: ["b", "a"], include: ["t", "tags", "u"] },
  perA: { kind: "count", on: ["a"], multi: false },
  perAB: { kind: "count", on: ["a", "b"], multi: false },
  perTag: { kind: "count", on: ["tags"], multi: true },
};
export const ARITY: Record<string, number> = { one: 1, two: 2, tags: 2, uniq: 1, search: 1, covered: 2, perA: 1, perAB: 2, perTag: 1 };

/** A unique multi index, which gives a document one unique entry per distinct element of `ut`. */
export const withUniqueTags = schema.collections.docs.unique("utags", "ut[]");
export const UNIQUE_TAGS = { name: "utags", model: { kind: "multi", on: ["ut"] }, arity: 1 } as const;
/** The indexes whose `eq` takes no list: the unique ones, and the count index on an array field, whose one field is that array's. */
const NO_LISTS: ReadonlySet<string> = new Set(["uniq", UNIQUE_TAGS.name, "perTag"]);

export type Docs = Collection<Doc, (typeof schema)["collections"]["docs"]["indexes"]>;
export type DocQuery = Query<Doc, (typeof schema)["collections"]["docs"]["indexes"]>;
type DocCountQuery = CountQuery<Doc, (typeof schema)["collections"]["docs"]["indexes"]>;

export const asQuery = (q: QueryInput) => q as DocQuery;
const asCountQuery = (q: QueryInput) => q as DocCountQuery;

const WORDS = ["Buy", "milk", "MILKSHAKE", "buyer", "Bacon", "rép", "Ünï", "x1", "2024", ",", " ", "-"];
export const textArb = fc.array(fc.constantFrom(...WORDS), { maxLength: 5 }).map((ws) => ws.join(" "));
const matchArb = fc
  .array(fc.constantFrom("bu", "BUY", "mi", "milk", "milks", "ba", "r", "ün", "x", "20", "q", "ilk", "uy", "HAKE", "ï", "1", "24"), { minLength: 1, maxLength: 2 })
  .map((ws) => ws.join(" "));
const idArb = stringArb.filter((s) => s !== "");

/** Values that documents often hold, for lists in `eq`. */
const poolArb = fc.constantFrom<Scalar>(null, false, true, 0, 1, -1, 0.5);

export const datasetArb = fc
  .tuple(
    fc.uniqueArray(
      fc.record(
        {
          id: idArb,
          a: fc.option(denseScalarArb, { nil: undefined }),
          b: fc.option(denseScalarArb, { nil: undefined }),
          tags: fc.option(fc.array(denseScalarArb, { maxLength: 4 }), { nil: undefined }),
          t: fc.option(fc.option(textArb, { nil: null, freq: 6 }), { nil: undefined }),
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

/** A query on the rows or on one of `indexes`, given by name with the number of fields of its `by`. */
export const queryArbOn = (indexes: Record<string, number>): fc.Arbitrary<{ index: string | undefined; q: QueryInput }> =>
  fc.constantFrom(undefined, ...Object.keys(indexes)).chain((index) => {
    const arity = index === undefined ? 1 : indexes[index]!;
    const value = index === undefined ? idArb : denseScalarArb;
    const counted = index !== undefined && MODEL[index]?.kind === "count";
    // A slot of `eq` can be a list, as long as the index takes one. Lists may repeat a value or be empty.
    const slot: fc.Arbitrary<Scalar | Scalar[]> =
      index === undefined || NO_LISTS.has(index)
        ? value
        : fc.oneof({ weight: 2, arbitrary: value }, { weight: 1, arbitrary: fc.array(fc.oneof(poolArb, value), { maxLength: 4 }) });
    return fc.integer({ min: 0, max: arity }).chain((k) =>
      fc
        .record({
          eq: fc.array(slot, { minLength: k, maxLength: k }),
          bound: k === arity ? fc.constant({}) : boundArb(value),
          reverse: counted ? fc.constant(false) : fc.boolean(),
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

function pick(doc: object, fields: readonly string[]): object {
  return Object.fromEntries(fields.filter((f) => Object.hasOwn(doc, f)).map((f) => [f, (doc as Record<string, unknown>)[f]]));
}

export const queryArb = queryArbOn(ARITY);

export async function checkQuery(
  c: Pick<Docs, "query" | "queryIds" | "queryEntries" | "count">,
  docs: readonly Doc[],
  index: string | undefined,
  q: QueryInput,
  pageSize: number,
  indexes: Record<string, ModelIndex> = MODEL,
): Promise<void> {
  const ix = index === undefined ? undefined : indexes[index];
  const want = expected(docs, ix, q);
  if (ix?.kind === "count") {
    expect(await c.count(asCountQuery(q))).toBe(want.length);
    expect(await c.count(asCountQuery({ ...q, limit: pageSize }))).toBe(Math.min(pageSize, want.length));
    for (const read of [c.query(asQuery(q)), c.queryIds(asQuery(q)), c.queryEntries(asQuery(q))]) {
      await expect(read).rejects.toMatchObject({ code: "query" });
    }
    return;
  }
  const query = asQuery(q);
  expect((await c.queryIds(query)).ids).toEqual(want.map((h) => h.id));
  const include = ix && "include" in ix ? ix.include : undefined;
  expect((await c.queryEntries(query)).entries).toStrictEqual(
    want.map(({ id, values, doc }) => (include ? { id, values, fields: pick(doc, include) } : { id, values })),
  );
  expect((await c.query(query)).docs).toEqual(want.map((h) => h.doc));
  expect(await c.count(query)).toBe(want.length);
  expect(await c.count(asQuery({ ...q, limit: pageSize }))).toBe(Math.min(pageSize, want.length));
  for (const offset of [1, pageSize]) {
    const rest = want.slice(offset);
    expect((await c.queryIds(asQuery({ ...q, offset }))).ids).toEqual(rest.map((h) => h.id));
    const page = await c.query(asQuery({ ...q, offset, limit: pageSize }));
    expect(page.docs).toEqual(rest.slice(0, pageSize).map((h) => h.doc));
    expect(page.next !== undefined).toBe(rest.length > pageSize);
    expect(await c.count(asQuery({ ...q, offset }))).toBe(rest.length);
  }

  const paged: string[] = [];
  let pages = 0;
  for (let after: Cursor | undefined; ; ) {
    const pageQuery = asQuery({ ...q, limit: pageSize, ...(after ? { after } : {}) });
    const page = await c.query(pageQuery);
    const entryPage = await c.queryEntries(pageQuery);
    const idPage = await c.queryIds(pageQuery);
    expect(entryPage.next).toBe(page.next);
    expect(entryPage.entries.map((e) => e.id)).toEqual(idPage.ids);
    expect(entryPage.next).toBe(idPage.next);
    pages++;
    paged.push(...page.docs.map((d) => d.id));
    if (page.next === undefined) break;
    expect(page.docs).toHaveLength(pageSize);
    after = page.next;
  }
  expect(paged).toEqual(want.map((h) => h.id));
  expect(pages).toBe(Math.max(1, Math.ceil(want.length / pageSize)));
}

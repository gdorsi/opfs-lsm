import fc from "fast-check";
import { IR, type Buildable, type QueryBuilder, type QueryRoot } from "../src/builder.js";
import type { Collection } from "../src/database.js";
import { compareRows, compile, orderKeyOf, valueAt, type Condition, type Ref, type Scalar } from "../src/expr.js";
import { and, collection, eq, gt, gte, ilike, inArray, like, lt, lte, not, or } from "../src/index.js";

/** Every index kind, and fields of every type an index orders. `x` has no index and may be missing. */
export type Row = {
  id: string;
  a: Scalar;
  b: Scalar;
  c: number | null;
  u: string;
  t: string | null;
  n: { m: Scalar };
  tags?: string[];
  x?: Scalar;
};

export const rowsDef = collection<Row>()
  .index("byA", "a")
  .index("byAB", ["a", "b"])
  .index("byBC", ["b", "c"])
  .index("byCBA", ["c", "b", "a"])
  .index("byNested", "n.m")
  .unique("byU", "u")
  .text("search", ["c", "a"], "t")
  .index("byTag", "tags[]");

const scalar: fc.Arbitrary<Scalar> = fc.constantFrom<Scalar>(null, false, true, -1, 0, 1, 1.5, 2, "", "a", "b", "é", "\u{1F600}");
const small: fc.Arbitrary<number | null> = fc.constantFrom(null, 0, 1, 2, 3);
const WORDS = ["fix", "Login", "page", "ΟΔΟΣ", "café", "café", "e", "x_y", "50%", "İstanbul", "a b"];
const text: fc.Arbitrary<string | null> = fc.oneof(
  { weight: 1, arbitrary: fc.constant(null) },
  { weight: 6, arbitrary: fc.array(fc.constantFrom(...WORDS), { maxLength: 3 }).map((w) => w.join(" ")) },
);

const IDS = Array.from({ length: 24 }, (_, i) => `r${String(i).padStart(2, "0")}`);
export const anyId = fc.constantFrom(...IDS);

export const rowArb = (id: fc.Arbitrary<string> = anyId): fc.Arbitrary<Row> =>
  fc.record(
    {
      id,
      a: scalar,
      b: scalar,
      c: small,
      t: text,
      n: fc.record({ m: scalar }, { noNullPrototype: true }),
      tags: fc.array(fc.constantFrom("p", "q"), { maxLength: 2 }),
      x: scalar,
    },
    { requiredKeys: ["id", "a", "b", "c", "t", "n"], noNullPrototype: true },
  ).map((row) => ({ ...row, u: `u-${row.id}` }));

/** Fields an update sets. `m` stands for `n.m`. */
export type Patch = { a?: Scalar; b?: Scalar; c?: number | null; t?: string | null; x?: Scalar; m?: Scalar };
export const patchArb: fc.Arbitrary<Patch> = fc.record({ a: scalar, b: scalar, c: small, t: text, x: scalar, m: scalar }, { requiredKeys: [], noNullPrototype: true });

export function patched(row: Row, { m, ...fields }: Patch): Row {
  return { ...row, ...fields, n: m === undefined ? row.n : { m } };
}

/** Rows with distinct ids. */
export const rowsArb = (max: number): fc.Arbitrary<Row[]> =>
  fc.uniqueArray(anyId, { maxLength: max }).chain((ids) => (ids.length === 0 ? fc.constant([]) : fc.tuple(...ids.map((id) => rowArb(fc.constant(id))))));

type Field = "a" | "b" | "c" | "u" | "x" | "id" | "n.m";
const FIELDS: Field[] = ["a", "b", "c", "u", "x", "id", "n.m"];
type Compare = "eq" | "gt" | "gte" | "lt" | "lte";

/** A condition as data, so that fast-check can print and shrink it. */
export type Cond =
  | { readonly op: Compare; readonly field: Field; readonly value: Scalar; readonly flipped: boolean }
  | { readonly op: "in"; readonly field: Field; readonly values: readonly Scalar[] }
  | { readonly op: "like" | "ilike"; readonly pattern: string }
  | { readonly op: "not"; readonly arg: Cond }
  | { readonly op: "and" | "or"; readonly args: readonly [Cond, Cond] };

export type Spec = {
  readonly where: readonly Cond[];
  readonly orderBy: readonly { readonly field: Field; readonly desc: boolean }[];
  readonly offset: number | undefined;
  readonly limit: number | undefined;
  readonly shape: "rows" | "one" | "count" | "select";
};

const value = (field: Field): fc.Arbitrary<Scalar> =>
  field === "id" ? fc.oneof(anyId, fc.constantFrom<Scalar>("", "r1", null)) : field === "u" ? fc.oneof(anyId.map((id) => `u-${id}`), scalar) : scalar;
const pattern = fc.oneof(
  fc.array(fc.constantFrom("%", "_", "fix", "LOG", "og", "pag", "ΟΔΟΣ", "οδοσ", "é", "e", "caf", "x", "50", "İ", " "), { maxLength: 4 }).map((p) => p.join("")),
  fc.constantFrom(...WORDS).map((w) => `%${w}%`),
  // Parts of words, which a text index finds inside a word: next to a combining mark, in another case, around a sigma.
  fc.tuple(fc.constantFrom("e", "E", "caf", "cafe", "é", "og", "LO", "σ", "ς", "Σ", "ο", "i", "İ", "x", "y", "5", "a", "b"), fc.constantFrom("", "_")).map(([part, one]) => `%${part}${one}%`),
);

const leaf: fc.Arbitrary<Cond> = fc.oneof(
  { weight: 5, arbitrary: fc.constantFrom(...FIELDS).chain((field) => fc.record({ op: fc.constantFrom<Compare>("eq", "gt", "gte", "lt", "lte"), field: fc.constant(field), value: value(field), flipped: fc.boolean() })) },
  { weight: 2, arbitrary: fc.constantFrom(...FIELDS).chain((field) => fc.record({ op: fc.constant("in" as const), field: fc.constant(field), values: fc.array(value(field), { maxLength: 4 }) })) },
  { weight: 2, arbitrary: fc.record({ op: fc.constantFrom("like" as const, "ilike" as const), pattern }) },
);
export const condArb: fc.Arbitrary<Cond> = fc.oneof(
  { weight: 6, arbitrary: leaf },
  { weight: 1, arbitrary: leaf.map((arg) => ({ op: "not" as const, arg })) },
  { weight: 2, arbitrary: fc.record({ op: fc.constantFrom("and" as const, "or" as const), args: fc.tuple(leaf, leaf) }) },
);

/** Small windows, so that a result is often full and often starts past rows a write can change. */
const window = {
  offset: fc.option(fc.integer({ min: 0, max: 4 }), { nil: undefined, freq: 3 }),
  limit: fc.option(fc.oneof({ weight: 1, arbitrary: fc.constant(0) }, { weight: 12, arbitrary: fc.integer({ min: 1, max: 6 }) }), { nil: undefined, freq: 3 }),
  shape: fc.constantFrom<Spec["shape"]>("rows", "rows", "one", "count", "select"),
};

const anySpec: fc.Arbitrary<Spec> = fc.record({
  where: fc.array(condArb, { maxLength: 3 }),
  orderBy: fc.array(fc.record({ field: fc.constantFrom(...FIELDS), desc: fc.boolean() }), { maxLength: 3 }),
  ...window,
});

/** A query cut to an index: its first fields pinned, a bound on the next, and an order the index can yield. */
const indexedSpec: fc.Arbitrary<Spec> = fc
  .record({
    by: fc.constantFrom<readonly Field[]>(["a"], ["a", "b"], ["b", "c"], ["c", "b", "a"], ["n.m"], ["u"], ["c", "a"]),
    pinned: fc.integer({ min: 0, max: 3 }),
    desc: fc.boolean(),
    orderSeed: fc.infiniteStream(fc.nat()),
    bounded: fc.boolean(),
    extra: fc.array(condArb, { maxLength: 1 }),
  })
  .chain(({ by, pinned, desc, orderSeed, bounded, extra }) => {
    const k = Math.min(pinned, by.length);
    const pins = fc.tuple(...by.slice(0, k).map((field) => fc.record({ op: fc.constant("in" as const), field: fc.constant(field), values: fc.uniqueArray(value(field), { minLength: 1, maxLength: 3 }) })));
    const bound = bounded && k < by.length ? leaf.filter((c) => "field" in c && c.field === by[k] && c.op !== "eq" && c.op !== "in") : fc.constant(undefined);
    return fc.record({ pins, bound, ...window }).map(({ pins, bound, ...rest }): Spec => {
      // The pinned fields in a shuffled order, then the fields the index orders by after them.
      const seeds = orderSeed.take(k);
      const shuffled = by.slice(0, k).map((field, i) => ({ field, at: [...seeds][i] ?? i })).sort((x, y) => x.at - y.at).map((x) => x.field);
      const orderBy = [...shuffled.filter((_, i) => i % 2 === 0 || k === 1), ...by.slice(k)].map((field) => ({ field, desc }));
      return { where: [...pins, ...(bound ? [bound] : []), ...extra], orderBy, ...rest };
    });
  });

export const specArb: fc.Arbitrary<Spec> = fc.oneof(anySpec, indexedSpec);

type Rows = Ref<Row>;
const ref = (i: Rows, field: Field) => (field === "n.m" ? i.n.m : i[field]) as Ref<number>;

function condition(i: Rows, cond: Cond): Condition {
  switch (cond.op) {
    case "in":
      return inArray(ref(i, cond.field), cond.values as number[]);
    case "like":
      return like(i.t, cond.pattern);
    case "ilike":
      return ilike(i.t, cond.pattern);
    case "not":
      return not(condition(i, cond.arg));
    case "and":
      return and(condition(i, cond.args[0]), condition(i, cond.args[1]));
    case "or":
      return or(condition(i, cond.args[0]), condition(i, cond.args[1]));
    default: {
      const op = { eq, gt, gte, lt, lte }[cond.op] as typeof gt;
      const field = ref(i, cond.field);
      return cond.flipped ? op(cond.value as number, field) : op(field, cond.value as number);
    }
  }
}

/** The query of `spec` over `rows`, as an app would write it. */
export function build(q: QueryRoot, rows: Collection<Row>, spec: Spec): Buildable<unknown> {
  let b: QueryBuilder<{ readonly i: Row }, unknown> = q.from({ i: rows });
  for (const cond of spec.where) b = b.where(({ i }) => condition(i, cond));
  for (const { field, desc } of spec.orderBy) b = b.orderBy(({ i }) => ref(i, field), desc ? "desc" : "asc");
  if (spec.offset !== undefined) b = b.offset(spec.offset);
  if (spec.limit !== undefined) b = b.limit(spec.limit);
  if (spec.shape === "select") b = b.select(({ i }) => ({ id: i.id, a: i.a, m: i.n.m, x: i.x }));
  return spec.shape === "one" ? b.findOne() : spec.shape === "count" ? b.count() : b;
}

/** What `query` must yield over `docs`: the filter and the order of the semantics module, applied to every document. */
export function expected(query: Buildable<unknown>, docs: readonly Row[]): unknown {
  const ir = query[IR];
  const where = compile(ir.where, ir.from.alias);
  const order = orderKeyOf(ir.orderBy);
  const end = ir.limit === undefined ? undefined : ir.offset + ir.limit;
  const window = docs.filter(where).sort((x, y) => compareRows(x, y, order)).slice(ir.offset, end);
  if (ir.shape === "count") return window.length;
  const { select } = ir;
  const rows = select ? window.map((doc) => Object.fromEntries(Object.entries(select).map(([name, path]) => [name, valueAt(doc, path)]))) : window;
  return ir.shape === "one" ? rows[0] : rows;
}

/** `DB_RUNS` widens a property test, and `DB_SEED` replays one. */
export function runs(byDefault: number): { readonly numRuns: number; readonly seed: number } {
  const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
  return { numRuns: Number(env["DB_RUNS"] ?? byDefault), seed: Number(env["DB_SEED"] ?? Date.now() % 1_000_000_000) };
}

/**
 * The differential check of differential.test.ts over shapes its generator
 * does not make: gte, lte and in on strings, bounds and in on booleans, eq
 * against null, isNull, two bounds on one path, fractional and large
 * numbers, a three-component index, an order on a boolean or on the second
 * or third component, ordered queries without a limit, and windows past the
 * end. It also runs on-demand and eager collections whose loads read
 * slowly while writes from this tab and another one land and windows move.
 * A window shows the order values TanStack shows, over rows the query keeps,
 * with any rows at a tie on its ends. After the writes, each document holds
 * the last write of one of the tabs that wrote it.
 *
 * TSDB_DIFF_RUNS (default 200 here, as each case is short) and TSDB_DIFF_SEED
 * replay or widen it.
 */
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { collection, defineSchema, openDocStore } from "@opfs-lsm/docstore";
import type { Db } from "@opfs-lsm/kv";
import { openHarnessDb } from "@opfs-lsm/kv/testing";
import {
  and,
  createCollection,
  createLiveQueryCollection,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNull,
  like,
  localOnlyCollectionOptions,
  lt,
  lte,
  not,
  or,
  type Collection,
} from "@tanstack/db";
import fc from "fast-check";
import { docstoreCollectionOptions, type DocstoreCollectionUtils } from "../src/index.ts";

type Doc = { id: string; g: number; k: boolean | null; n: number | null; s: string | null; t: string };

const schema = defineSchema({
  version: 1,
  collections: {
    docs: collection<Doc>()
      .index("byS", "s")
      .index("byKN", ["k", "n"])
      .index("byGKS", ["g", "k", "s"])
      .index("bySN", ["s", "n"])
      .index("byNG", ["n", "g"])
      .text("search", ["g"], "t"),
  },
});

const IDS = Array.from({ length: 24 }, (_, i) => `d${String(i).padStart(2, "0")}`);
const STRINGS = ["a", "A", "ab", "b", "", " ", "z", "é", "Ａ", "\u{1F600}", "10", "9"];
const NUMBERS = [-1e20, -3.5, -1, -0.25, 0, 0.1, 0.2, 1, 1.5, 2, 9007199254740991, 1e21];
const TEXTS = ["red apple", "Green pie", "apple_pie", "blue", "", "x-ray APPLE", "under_score", "100%"];

const fieldsArb = fc.record({
  g: fc.integer({ min: 0, max: 2 }),
  k: fc.option(fc.boolean(), { nil: null, freq: 4 }),
  n: fc.option(fc.constantFrom(...NUMBERS), { nil: null, freq: 5 }),
  s: fc.option(fc.constantFrom(...STRINGS), { nil: null, freq: 5 }),
  t: fc.constantFrom(...TEXTS),
});

const docsArb = fc
  .uniqueArray(fc.constantFrom(...IDS), { minLength: 3, maxLength: IDS.length })
  .chain((ids) => fc.tuple(...ids.map((id) => fieldsArb.map((f): Doc => ({ id, ...f })))));

type Op = "eq" | "gt" | "gte" | "lt" | "lte";
type Field = "g" | "k" | "n" | "s";

type Cond =
  | { readonly op: Op; readonly field: Field; readonly value: number | string | boolean; readonly flip: boolean }
  | { readonly op: "in"; readonly field: Field; readonly values: readonly (number | string | boolean | null)[] }
  | { readonly op: "eqNull" | "isNull" | "notNull"; readonly field: Field }
  | { readonly op: "like" | "ilike"; readonly pattern: string }
  | { readonly op: "or" | "not"; readonly value: number };

const valueOf = (field: Field): fc.Arbitrary<number | string | boolean> =>
  field === "g" ? fc.integer({ min: 0, max: 2 }) : field === "k" ? fc.boolean() : field === "n" ? fc.constantFrom(...NUMBERS) : fc.constantFrom(...STRINGS);

const fieldArb = fc.constantFrom<Field>("g", "k", "n", "s");

const condArb: fc.Arbitrary<Cond> = fc.oneof(
  { weight: 5, arbitrary: fieldArb.chain((field) => fc.record({ op: fc.constantFrom<Op>("eq", "gt", "gte", "lt", "lte"), field: fc.constant(field), value: valueOf(field), flip: fc.boolean() })) },
  {
    weight: 2,
    arbitrary: fieldArb.chain((field) =>
      fc.record({ op: fc.constant("in" as const), field: fc.constant(field), values: fc.array(fc.option(valueOf(field), { nil: null, freq: 6 }), { maxLength: 4 }) }),
    ),
  },
  { weight: 1, arbitrary: fc.record({ op: fc.constantFrom("eqNull" as const, "isNull" as const, "notNull" as const), field: fieldArb }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constantFrom("like" as const, "ilike" as const), pattern: fc.constantFrom("%apple%", "%APPLE%", "%e_p%", "%_%", "apple_pie", "%100\\%%", "%ray%", "blue", "%r%e%") }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constantFrom("or" as const, "not" as const), value: fc.integer({ min: 0, max: 2 }) }) },
);

type OrderKey = { readonly field: Field; readonly dir: "asc" | "desc"; readonly nulls: "first" | "last"; readonly stringSort: "lexical" | "locale" };
const orderKeyArb: fc.Arbitrary<OrderKey> = fc.record({
  field: fieldArb,
  dir: fc.constantFrom("asc", "desc"),
  nulls: fc.constantFrom("first", "last"),
  stringSort: fc.constantFrom("lexical", "locale"),
});

type Spec = {
  readonly conds: readonly Cond[];
  readonly order: readonly OrderKey[];
  readonly window?: { readonly offset: number; readonly limit: number };
  readonly moves: readonly { readonly offset: number; readonly limit: number }[];
};

const windowArb = fc.record({ offset: fc.integer({ min: 0, max: 30 }), limit: fc.integer({ min: 1, max: 30 }) });

const specArb: fc.Arbitrary<Spec> = fc
  .record({
    conds: fc.array(condArb, { maxLength: 3 }),
    order: fc.array(orderKeyArb, { maxLength: 2 }),
    window: fc.option(windowArb, { nil: undefined, freq: 3 }),
    moves: fc.array(windowArb, { maxLength: 2 }),
  })
  .map((s) => (s.order.length > 0 ? s : { ...s, window: undefined, moves: [] }) as Spec);

type Write = { readonly via: "transact" | "other"; readonly id: string; readonly fields: Omit<Doc, "id"> | null };

const writeArb: fc.Arbitrary<Write> = fc.record({
  via: fc.constantFrom("transact", "other"),
  id: fc.constantFrom(...IDS),
  fields: fc.option(fieldsArb, { nil: null, freq: 4 }),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function condition(c: Cond, d: any) {
  switch (c.op) {
    case "in":
      return inArray(d[c.field], [...c.values]);
    case "eqNull":
      return eq(d[c.field], null);
    case "isNull":
      return isNull(d[c.field]);
    case "notNull":
      return not(isNull(d[c.field]));
    case "like":
      return like(d.t, c.pattern);
    case "ilike":
      return ilike(d.t, c.pattern);
    case "or":
      return or(eq(d.g, c.value), eq(d.k, true));
    case "not":
      return not(eq(d.g, c.value));
    default: {
      const f = { eq, gt, gte, lt, lte }[c.op];
      return c.flip ? f(c.value, d[c.field]) : f(d[c.field], c.value);
    }
  }
}

function liveQuery(source: Collection<Doc, string, any>, spec: Spec) {
  return createLiveQueryCollection((q) => {
    let b = q.from({ d: source });
    const [first, ...rest] = spec.conds;
    if (first) b = b.where(({ d }) => rest.reduce((all, c) => and(all, condition(c, d)), condition(first, d)));
    if (spec.order.length === 0) return b;
    let o = b.orderBy(({ d }) => d[spec.order[0]!.field], pick(spec.order[0]!));
    for (const key of spec.order.slice(1)) o = o.orderBy(({ d }) => d[key.field], pick(key));
    if (spec.window) o = o.limit(spec.window.limit).offset(spec.window.offset);
    return o;
  });
}

const pick = (k: OrderKey) => ({ direction: k.dir, nulls: k.nulls, stringSort: k.stringSort });

const strip = (rows: readonly object[]) => rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith("$"))) as Doc);
const byId = (a: Doc, b: Doc) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

type Rows = { toArray: readonly object[] };
type Window = { readonly offset: number; readonly limit: number };

/**
 * A live query under test, `want` over every document, and for a window
 * `full`, the same query without it, with `window` the one last set.
 */
type Query = { readonly spec: Spec; readonly got: Live; readonly want: Live; readonly full?: Live; window?: Window };
type Live = ReturnType<typeof liveQuery>;
const live = (q: Query) => [q.got, q.want, ...(q.full ? [q.full] : [])];

/**
 * An ordered window's order values; its ids are checked by `badSelection`,
 * since TanStack breaks ties by insertion into its index, which differs
 * between the two collections.
 */
function shown(q: Rows, spec: Spec): unknown {
  const rows = strip(q.toArray);
  if (spec.order.length === 0) return rows.sort(byId);
  if (!spec.window) return rows.map((r) => spec.order.map((k) => r[k.field]).concat(r.id)).sort();
  return rows.map((r) => spec.order.map((k) => r[k.field]));
}

/**
 * Why `rows` is no window of `full` at `offset` and `limit`: a row the filter
 * drops, shown twice or with other fields, a wrong count, or a row missing
 * whose order value lies strictly inside the window. Ties at its two ends
 * may pick any rows.
 */
function badSelection(rows: readonly Doc[], full: readonly Doc[], order: readonly OrderKey[], { offset, limit }: Window): string | undefined {
  const byKey = new Map(full.map((d) => [d.id, d]));
  const ids = rows.map((r) => r.id);
  if (new Set(ids).size !== ids.length) return `shows an id twice: ${ids.join(",")}`;
  const stray = rows.find((r) => !isDeepStrictEqual(r, byKey.get(r.id)));
  if (stray) return `shows ${JSON.stringify(stray)}, but the query over every document holds ${JSON.stringify(byKey.get(stray.id))}`;
  const size = Math.min(limit, Math.max(0, full.length - offset));
  if (rows.length !== size) return `shows ${rows.length} rows, not min(limit ${limit}, ${full.length} matching - offset ${offset})`;
  const window = full.slice(offset, offset + limit);
  const value = (d: Doc) => JSON.stringify(order.map((k) => d[k.field]));
  const ends = new Set(window.length > 0 ? [value(window[0]!), value(window.at(-1)!)] : []);
  const missing = window.filter((d) => !ends.has(value(d)) && !ids.includes(d.id));
  if (missing.length > 0) return `misses ${missing.map((d) => d.id).join(",")}, inside the window by order value`;
  return undefined;
}

function mismatch(q: Query): string | undefined {
  if (JSON.stringify(shown(q.got, q.spec)) !== JSON.stringify(shown(q.want, q.spec))) return "order values";
  return q.full && q.window && badSelection(strip(q.got.toArray), strip(q.full.toArray), q.spec.order, q.window);
}

async function agree(queries: readonly Query[], what: string) {
  const deadline = Date.now() + 3000;
  for (;;) {
    const diff = queries.find((q) => mismatch(q) !== undefined);
    if (!diff) return;
    if (Date.now() > deadline) {
      const message = `${what}: ${JSON.stringify(diff.spec)} at ${JSON.stringify(diff.window)}`;
      assert.deepEqual(shown(diff.got, diff.spec), shown(diff.want, diff.spec), message);
      assert.fail(`${message}: ${mismatch(diff)}`);
    }
    await new Promise((r) => setTimeout(r, 2));
  }
}

/**
 * Why `stored` loses a write. Writes of one id through one handle land in
 * call order, and through the two handles in either, so each id holds the
 * last write of one of the handles that wrote it, or its first document.
 */
function lostWrite(initial: readonly Doc[], writes: readonly Write[], stored: readonly (Doc | undefined)[]): string | undefined {
  for (const [i, id] of IDS.entries()) {
    const last = new Map<Write["via"], Doc | null>();
    for (const w of writes) if (w.id === id) last.set(w.via, w.fields && { id, ...w.fields });
    const allowed = last.size > 0 ? [...last.values()] : [initial.find((d) => d.id === id) ?? null];
    const got = stored[i] ?? null;
    if (!allowed.some((doc) => isDeepStrictEqual(doc, got))) {
      return `${id} holds ${JSON.stringify(got)}, and the last writes allow ${allowed.map((doc) => JSON.stringify(doc)).join(" or ")}`;
    }
  }
  return undefined;
}

let dbs = 0;
let cases = 0;

/** `docs` whose snapshot reads wait `ticks` turns of the event loop, so writes land while a load reads. */
function slowViews<C extends { view: (body: (snap: never) => Promise<unknown>) => Promise<unknown> }>(docs: C, ticks: number): C {
  return new Proxy(docs, {
    get(target, prop) {
      if (prop === "view") {
        return (body: (snap: never) => Promise<unknown>) =>
          target.view(async (snap) => {
            for (let i = 0; i < ticks; i++) await new Promise((r) => setImmediate(r));
            return body(snap);
          });
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** With `ticks`, writes from this tab and another one and window moves race the loads. */
async function check(docs: readonly Doc[], specs: readonly Spec[], writes: readonly Write[], ticks?: number, syncMode: "eager" | "on-demand" = "on-demand") {
  const name = `tsdb-wide-${process.pid}-${++dbs}`;
  const kvs: Db[] = [await openHarnessDb({ name, forceMemory: true, maxWalBytes: 1 << 30 })];
  kvs.push(await openHarnessDb({ name, forceMemory: true, maxWalBytes: 1 << 30 }));
  const [mine, other] = await Promise.all(kvs.map(async (kv) => (await openDocStore(kv, schema)).collection("docs")));
  await mine!.putMany(docs);
  const concurrent = ticks !== undefined;
  const source = concurrent ? slowViews(mine!, ticks) : mine!;
  const target = createCollection(docstoreCollectionOptions({ collection: source, syncMode })) as Collection<Doc, string, DocstoreCollectionUtils<Doc>>;
  const reference = createCollection(localOnlyCollectionOptions({ getKey: (d: Doc) => d.id, initialData: [...docs] }));
  const model = new Map(docs.map((d) => [d.id, d]));
  const set = (id: string, doc: Doc | null) => {
    if (doc) {
      if (model.has(id)) reference.update(id, (draft) => Object.assign(draft, doc));
      else reference.insert(doc);
      model.set(id, doc);
    } else if (model.delete(id)) {
      reference.delete(id);
    }
  };
  const queries: Query[] = specs.map((spec) => ({
    spec,
    got: liveQuery(target, spec),
    want: liveQuery(reference, spec),
    ...(spec.window && { full: liveQuery(reference, { ...spec, window: undefined, moves: [] }), window: spec.window }),
  }));
  try {
    if (concurrent) {
      const loads = queries.flatMap((q) => live(q).map((c) => c.preload()));
      const others: Promise<unknown>[] = [];
      for (const w of writes) {
        const doc = w.fields && { id: w.id, ...w.fields };
        if (w.via === "transact") others.push(target.utils.transact([w.id], () => [doc]));
        else others.push(doc ? other!.putMany([doc]) : other!.delete(w.id));
        await new Promise((r) => setImmediate(r));
      }
      // @tanstack/db 1.0.0-rc.1.5 drops a window moved while the first load of an unindexed source is in flight, and the query stays empty.
      await Promise.all(loads);
      for (const q of queries) {
        for (const move of q.spec.window ? q.spec.moves : []) {
          others.push(q.got.utils.setWindow(move) as Promise<unknown>, q.want.utils.setWindow(move) as Promise<unknown>);
          q.window = move;
          await new Promise((r) => setImmediate(r));
        }
      }
      await Promise.all([...loads, ...others]);
      // Writes of one id from both tabs commit in either order: the database says which won.
      await kvs[0]!.sync();
      const stored = await mine!.getMany(IDS);
      const lost = lostWrite(docs, writes, stored);
      if (lost) assert.fail(`after concurrent writes ${JSON.stringify(writes)}: ${lost}`);
      IDS.forEach((id, i) => set(id, stored[i] ?? null));
      await agree(queries, `after concurrent writes ${JSON.stringify(writes)}`);
      cases++;
      return;
    }
    await Promise.all(queries.flatMap((q) => live(q).map((c) => c.preload())));
    await agree(queries, "at rest");
    for (const w of writes) {
      const doc = w.fields && { id: w.id, ...w.fields };
      if (w.via === "transact") await target.utils.transact([w.id], () => [doc]);
      else if (doc) await other!.putMany([doc]);
      else await other!.delete(w.id);
      set(w.id, doc);
      await agree(queries, `after ${JSON.stringify(w)}`);
    }
    for (const q of queries) {
      for (const move of q.spec.window ? q.spec.moves : []) {
        await Promise.all([q.got.utils.setWindow(move), q.want.utils.setWindow(move)]);
        q.window = move;
        await agree([q], `after setWindow(${JSON.stringify(move)})`);
      }
    }
    cases++;
  } finally {
    for (const q of queries) await Promise.all(live(q).map((c) => c.cleanup()));
    await Promise.all([target.cleanup(), reference.cleanup()]);
    for (const kv of kvs) await kv.close();
  }
}

function sweep(concurrent: boolean, syncMode: "eager" | "on-demand") {
  const runs = Number(process.env.TSDB_DIFF_RUNS ?? 200);
  const seed = process.env.TSDB_DIFF_SEED === undefined ? undefined : Number(process.env.TSDB_DIFF_SEED);
  return fc.assert(
    fc.asyncProperty(
      docsArb,
      fc.array(specArb, { minLength: 1, maxLength: 3 }),
      fc.array(writeArb, { maxLength: 8 }),
      fc.integer({ min: 0, max: 6 }),
      (docs, specs, writes, ticks) => check(docs, specs, writes, concurrent ? ticks : undefined, syncMode),
    ),
    { numRuns: runs, ...(seed !== undefined && { seed }), endOnFailure: true },
  );
}

test("on-demand live queries over wider operators, types and orders show what TanStack shows over every document", { timeout: 600_000 }, async () => {
  await sweep(false, "on-demand");
  console.log(`differential-wide: ${cases} cases passed`);
});

test("on-demand live queries agree with TanStack when both tabs write and windows move while loads read", { timeout: 600_000 }, () =>
  sweep(true, "on-demand"),
);

test("eager live queries agree with TanStack when both tabs write while the first load reads", { timeout: 600_000 }, () =>
  sweep(true, "eager"),
);

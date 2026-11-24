/**
 * The differential check of differential.test.ts over shapes its generator
 * does not make: ids that sort apart by code point, UTF-16 unit and locale,
 * a nested indexed path, a boolean order field, an index whose order field
 * follows a pinned field, and manual transactions through acceptMutations.
 *
 * TSDB_SHAPES_RUNS (default 200) and TSDB_SHAPES_SEED replay or widen it.
 */
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { collection, defineSchema, openDocStore } from "@opfs-lsm/docstore";
import type { Db } from "@opfs-lsm/kv";
import { openHarnessDb } from "@opfs-lsm/kv/testing";
import {
  and,
  createCollection,
  createLiveQueryCollection,
  createTransaction,
  eq,
  gt,
  gte,
  inArray,
  localOnlyCollectionOptions,
  lt,
  lte,
  not,
  type Collection,
} from "@tanstack/db";
import fc from "fast-check";
import { docstoreCollectionOptions, type DocstoreCollectionUtils } from "../src/index.ts";

type Doc = { id: string; g: number; k: boolean | null; m: { r: number | null }; s: string | null };

const schema = defineSchema({
  version: 1,
  collections: {
    docs: collection<Doc>().index("byR", "m.r").index("byGR", ["g", "m.r"]).index("byK", ["k", "s"]).index("byGK", ["g", "k"]),
  },
});

// Ids that compare apart by code point, UTF-16 unit and locale.
const IDS = ["a", "B", "b", "ä", "Z", "z0", "\u{1F600}", "Ａ", "", "10", "9", "a b", "A", "é", "é", "_", "-"];
const STRINGS = ["a", "B", "b", "", "\u{1F600}", "Ａ"];
const NUMBERS = [-1, 0, 1, 2, 3];

const fieldsArb = fc.record({
  g: fc.integer({ min: 0, max: 2 }),
  k: fc.option(fc.boolean(), { nil: null, freq: 5 }),
  m: fc.record({ r: fc.option(fc.constantFrom(...NUMBERS), { nil: null, freq: 5 }) }),
  s: fc.option(fc.constantFrom(...STRINGS), { nil: null, freq: 5 }),
});

const docsArb = fc
  .uniqueArray(fc.constantFrom(...IDS), { minLength: 3, maxLength: IDS.length })
  .chain((ids) => fc.tuple(...ids.map((id) => fieldsArb.map((f): Doc => ({ id, ...f })))));

type Cond =
  | { readonly op: "eq" | "gt" | "gte" | "lt" | "lte"; readonly field: "g" | "m.r"; readonly value: number; readonly flip: boolean }
  | { readonly op: "in"; readonly field: "g" | "m.r"; readonly values: readonly (number | null)[] }
  | { readonly op: "eq"; readonly field: "k"; readonly value: boolean }
  | { readonly op: "not"; readonly value: number };

const condArb: fc.Arbitrary<Cond> = fc.oneof(
  fc.record({
    op: fc.constantFrom("eq", "gt", "gte", "lt", "lte"),
    field: fc.constantFrom("g", "m.r"),
    value: fc.constantFrom(...NUMBERS),
    flip: fc.boolean(),
  }),
  fc.record({
    op: fc.constant("in"),
    field: fc.constantFrom("g", "m.r"),
    values: fc.uniqueArray(fc.option(fc.constantFrom(...NUMBERS), { nil: null, freq: 5 }), { maxLength: 3 }),
  }),
  fc.record({ op: fc.constant("eq"), field: fc.constant("k"), value: fc.boolean() }),
  fc.record({ op: fc.constant("not"), value: fc.integer({ min: 0, max: 2 }) }),
) as fc.Arbitrary<Cond>;

type Field = "m.r" | "k" | "s";

type Spec = {
  readonly conds: readonly Cond[];
  readonly order?: {
    readonly field: Field;
    readonly dir: "asc" | "desc";
    readonly nulls: "first" | "last";
    readonly then?: { readonly field: "g" | "id"; readonly dir: "asc" | "desc" };
  };
  readonly window?: { readonly offset: number; readonly limit: number };
  readonly moves: readonly { readonly offset: number; readonly limit: number }[];
};

const windowArb = fc.record({ offset: fc.integer({ min: 0, max: 5 }), limit: fc.integer({ min: 1, max: 6 }) });

const specArb: fc.Arbitrary<Spec> = fc
  .record({
    conds: fc.array(condArb, { maxLength: 2 }),
    order: fc.option(
      fc.record({
        field: fc.constantFrom<Field>("m.r", "k", "s"),
        dir: fc.constantFrom("asc", "desc"),
        nulls: fc.constantFrom("first", "last"),
        then: fc.option(fc.record({ field: fc.constantFrom("g", "id"), dir: fc.constantFrom("asc", "desc") }), { nil: undefined }),
      }),
      { nil: undefined, freq: 4 },
    ),
    window: fc.option(windowArb, { nil: undefined, freq: 4 }),
    moves: fc.array(windowArb, { maxLength: 2 }),
  })
  .map((s) => (s.order ? s : { ...s, window: undefined, moves: [] }) as Spec);

type Write = { readonly via: "transact" | "other" | "manual"; readonly id: string; readonly fields: Omit<Doc, "id"> | null };

const writeArb: fc.Arbitrary<Write> = fc.record({
  via: fc.constantFrom("transact", "other", "manual"),
  id: fc.constantFrom(...IDS),
  fields: fc.option(fieldsArb, { nil: null, freq: 4 }),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const at = (d: any, field: string) => (field === "m.r" ? d.m.r : d[field]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function condition(c: Cond, d: any) {
  switch (c.op) {
    case "in":
      return inArray(at(d, c.field), [...c.values]);
    case "not":
      return not(eq(d.g, c.value));
    default: {
      const f = { eq, gt, gte, lt, lte }[c.op];
      return "flip" in c && c.flip ? f(c.value, at(d, c.field)) : f(at(d, c.field), c.value);
    }
  }
}

function liveQuery(source: Collection<Doc, string, any>, spec: Spec) {
  return createLiveQueryCollection((q) => {
    let b = q.from({ d: source });
    const [first, ...rest] = spec.conds;
    if (first) b = b.where(({ d }) => rest.reduce((all, c) => and(all, condition(c, d)), condition(first, d)));
    if (!spec.order) return b;
    const { field, dir, nulls, then } = spec.order;
    let o = b.orderBy(({ d }) => at(d, field), { direction: dir, nulls, stringSort: "lexical" });
    if (then) o = o.orderBy(({ d }) => d[then.field], { direction: then.dir, nulls, stringSort: "lexical" });
    if (spec.window) o = o.limit(spec.window.limit).offset(spec.window.offset);
    return o;
  });
}

const strip = (rows: readonly object[]) =>
  rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith("$"))) as Doc);

function shown(q: { toArray: readonly object[] }, ordered: boolean): Doc[] {
  const rows = strip(q.toArray);
  return ordered ? rows : rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function agree(pairs: readonly { got: { toArray: readonly object[] }; want: { toArray: readonly object[] }; spec: Spec }[], what: string) {
  const deadline = Date.now() + 3000;
  for (;;) {
    const diff = pairs.find((p) => !equal(shown(p.got, !!p.spec.order), shown(p.want, !!p.spec.order)));
    if (!diff) return;
    if (Date.now() > deadline) {
      assert.deepEqual(shown(diff.got, !!diff.spec.order), shown(diff.want, !!diff.spec.order), `${what}: ${JSON.stringify(diff.spec)}`);
    }
    await new Promise((r) => setTimeout(r, 2));
  }
}

let dbs = 0;
let cases = 0;

async function check(docs: readonly Doc[], specs: readonly Spec[], writes: readonly Write[]) {
  const name = `tsdb-shapes-${process.pid}-${++dbs}`;
  const kvs: Db[] = [await openHarnessDb({ name, forceMemory: true, maxWalBytes: 1 << 30 })];
  kvs.push(await openHarnessDb({ name, forceMemory: true, maxWalBytes: 1 << 30 }));
  const [mine, other] = await Promise.all(kvs.map(async (kv) => (await openDocStore(kv, schema)).collection("docs")));
  await mine!.putMany(docs);
  const target = createCollection(docstoreCollectionOptions({ collection: mine!, syncMode: "on-demand" }));
  const model = new Map(docs.map((d) => [d.id, d]));
  const reference = createCollection(localOnlyCollectionOptions({ getKey: (d: Doc) => d.id, initialData: [...docs] }));
  const queries = specs.map((spec) => ({ spec, got: liveQuery(target, spec), want: liveQuery(reference, spec) }));
  try {
    await Promise.all(queries.flatMap((q) => [q.got.preload(), q.want.preload()]));
    await agree(queries, "at rest");
    for (const w of writes) {
      const doc = w.fields && { id: w.id, ...w.fields };
      await write(w, doc, target, other!, queries.length > 1);
      if (doc) {
        if (model.has(w.id)) reference.update(w.id, (draft) => Object.assign(draft, doc));
        else reference.insert(doc);
        model.set(w.id, doc);
      } else if (model.delete(w.id)) {
        reference.delete(w.id);
      }
      await agree(queries, `after ${JSON.stringify(w)}`);
    }
    for (const q of queries) {
      for (const move of q.spec.window ? q.spec.moves : []) {
        await Promise.all([q.got.utils.setWindow(move), q.want.utils.setWindow(move)]);
        await agree([q], `after setWindow(${JSON.stringify(move)})`);
      }
    }
    cases++;
  } finally {
    for (const q of queries) await Promise.all([q.got.cleanup(), q.want.cleanup()]);
    await Promise.all([target.cleanup(), reference.cleanup()]);
    for (const kv of kvs) await kv.close();
  }
}

async function write(
  w: Write,
  doc: Doc | null,
  target: Collection<Doc, string, DocstoreCollectionUtils<Doc>>,
  other: { putMany(d: Doc[]): Promise<void>; delete(id: string): Promise<boolean> },
  shared: boolean,
) {
  switch (w.via) {
    case "transact":
      return target.utils.transact([w.id], () => [doc]);
    case "other":
      return doc ? other.putMany([doc]) : void (await other.delete(w.id));
    case "manual": {
      // differential.test.ts: an optimistic write next to other live queries makes TanStack refill windows on its own.
      if (shared || (!doc && !target.has(w.id))) return target.utils.transact([w.id], () => [doc]);
      const tx = createTransaction({ mutationFn: ({ transaction }) => target.utils.acceptMutations(transaction) });
      tx.mutate(() => {
        if (!doc) target.delete(w.id);
        else if (target.has(w.id)) target.update(w.id, (draft) => Object.assign(draft, doc));
        else target.insert(doc);
      });
      return tx.when("settled");
    }
  }
}

test("on-demand live queries over nested paths, boolean orders and ids that sort apart show what TanStack shows over every document", { timeout: 600_000 }, async () => {
  const runs = Number(process.env.TSDB_SHAPES_RUNS ?? 200);
  const seed = process.env.TSDB_SHAPES_SEED === undefined ? undefined : Number(process.env.TSDB_SHAPES_SEED);
  await fc.assert(
    fc.asyncProperty(docsArb, fc.array(specArb, { minLength: 1, maxLength: 3 }), fc.array(writeArb, { maxLength: 8 }), (docs, specs, writes) =>
      check(docs, specs, writes),
    ),
    { numRuns: runs, ...(seed !== undefined && { seed }), endOnFailure: true },
  );
  console.log(`differential shapes: ${cases} cases passed`);
});

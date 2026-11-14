/**
 * The adapter's on-demand loads against TanStack itself: a live query over an
 * on-demand docstore-backed collection must show the same rows, in the same
 * order, as the same live query over an in-memory collection that holds every
 * document. Writes go through `transact`, TanStack mutations, and a second
 * docstore handle on the same kv (another tab).
 *
 * TSDB_DIFF_RUNS (default 40) and TSDB_DIFF_SEED replay or widen it.
 * TSDB_DIFF_REPORT=1 prints how many loads of each shape TanStack issued.
 */
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { defineSchema, openDocStore } from "@opfs-lsm/docstore";
import type { Db } from "@opfs-lsm/kv";
import { openHarnessDb } from "@opfs-lsm/kv/testing";
import {
  and,
  BTreeIndex,
  createCollection,
  createLiveQueryCollection,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  localOnlyCollectionOptions,
  lt,
  lte,
  not,
  or,
  type Collection,
} from "@tanstack/db";
import fc from "fast-check";
import { docstoreCollectionOptions, type DocstoreCollectionUtils } from "../src/index.ts";

type Doc = { id: string; g: number; k: boolean; n: number | null; s: string | null; t: string };

const schema = defineSchema<{ docs: Doc }>()({
  version: 1,
  collections: {
    docs: {
      byN: { by: "n" },
      byGN: { by: ["g", "n"] },
      byKS: { by: ["k", "s"] },
      byGS: { by: ["g", "s"] },
      search: { by: ["k", "n"], text: "t" },
    },
  },
});

const IDS = Array.from({ length: 30 }, (_, i) => `d${String(i).padStart(2, "0")}`);
const STRINGS = ["a", "B", "b", "ab", "Ba", "c", "", "a b"];
const TEXTS = ["red apple", "Green pie", "apple pie", "blue", "", "sky-blue APPLE"];

const fieldsArb = fc.record({
  g: fc.integer({ min: 0, max: 3 }),
  k: fc.boolean(),
  n: fc.option(fc.integer({ min: 0, max: 6 }), { nil: null, freq: 6 }),
  s: fc.option(fc.constantFrom(...STRINGS), { nil: null, freq: 6 }),
  t: fc.constantFrom(...TEXTS),
});

const docsArb = fc
  .uniqueArray(fc.constantFrom(...IDS), { minLength: 4, maxLength: 24 })
  .chain((ids) => fc.tuple(...ids.map((id) => fieldsArb.map((f): Doc => ({ id, ...f })))));

type Cond =
  | { readonly op: "eq" | "gt" | "gte" | "lt" | "lte"; readonly field: "g" | "n"; readonly value: number }
  | { readonly op: "gt" | "lt" | "eq"; readonly field: "s"; readonly value: string }
  | { readonly op: "in"; readonly field: "g"; readonly values: readonly number[] }
  | { readonly op: "eq"; readonly field: "k"; readonly value: boolean }
  | { readonly op: "ilike"; readonly pattern: string }
  | { readonly op: "or" | "not"; readonly value: number };

const condArb: fc.Arbitrary<Cond> = fc.oneof(
  fc.record({ op: fc.constantFrom("eq", "gt", "gte", "lt", "lte"), field: fc.constantFrom("g", "n"), value: fc.integer({ min: 0, max: 6 }) }),
  fc.record({ op: fc.constantFrom("gt", "lt", "eq"), field: fc.constant("s"), value: fc.constantFrom(...STRINGS) }),
  fc.record({ op: fc.constant("in"), field: fc.constant("g"), values: fc.uniqueArray(fc.integer({ min: 0, max: 3 }), { maxLength: 3 }) }),
  fc.record({ op: fc.constant("eq"), field: fc.constant("k"), value: fc.boolean() }),
  fc.record({ op: fc.constant("ilike"), pattern: fc.constantFrom("%apple%", "%PIE%", "%e%", "%sky-b%", "% %", "%%", "blue") }),
  fc.record({ op: fc.constantFrom("or", "not"), value: fc.integer({ min: 0, max: 3 }) }),
) as fc.Arbitrary<Cond>;

type Spec = {
  readonly conds: readonly Cond[];
  readonly order?: {
    readonly field: "n" | "s";
    readonly dir: "asc" | "desc";
    readonly nulls: "first" | "last";
    readonly stringSort: "lexical" | "locale";
    /** A second order key, before the id tiebreak. */
    readonly then?: { readonly field: "g" | "n" | "s"; readonly dir: "asc" | "desc" };
    /** Without it, TanStack breaks ties by the row key. */
    readonly byId: boolean;
    /**
     * An anchored window: only rows at or after this value of the order field, as a list that shows a window deep
     * in a long order starts its own query there. An index into the field's values.
     */
    readonly anchor?: number;
  };
  readonly window?: { readonly offset: number; readonly limit: number };
  readonly moves: readonly { readonly offset: number; readonly limit: number }[];
};

const windowArb = fc.record({ offset: fc.integer({ min: 0, max: 6 }), limit: fc.integer({ min: 1, max: 8 }) });

const specArb: fc.Arbitrary<Spec> = fc
  .record({
    conds: fc.array(condArb, { maxLength: 3 }),
    order: fc.option(
      fc.record({
        field: fc.constantFrom("n", "s"),
        dir: fc.constantFrom("asc", "desc"),
        nulls: fc.constantFrom("first", "last"),
        stringSort: fc.constantFrom("lexical", "locale"),
        then: fc.option(fc.record({ field: fc.constantFrom("g", "n", "s"), dir: fc.constantFrom("asc", "desc") }), {
          nil: undefined,
        }),
        byId: fc.boolean(),
        anchor: fc.option(fc.integer({ min: 0, max: STRINGS.length - 1 }), { nil: undefined }),
      }),
      { nil: undefined, freq: 4 },
    ),
    window: fc.option(windowArb, { nil: undefined, freq: 4 }),
    moves: fc.array(windowArb, { maxLength: 2 }),
  })
  .map((s) => (s.order ? s : { ...s, window: undefined, moves: [] }) as Spec);

type Write = { readonly via: "transact" | "mutate" | "other"; readonly id: string; readonly fields: Omit<Doc, "id"> | null };

const writeArb: fc.Arbitrary<Write> = fc.record({
  via: fc.constantFrom("transact", "mutate", "other"),
  id: fc.constantFrom(...IDS),
  fields: fc.option(fieldsArb, { nil: null, freq: 4 }),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function condition(c: Cond, d: any) {
  switch (c.op) {
    case "in":
      return inArray(d.g, [...c.values]);
    case "ilike":
      return ilike(d.t, c.pattern);
    case "or":
      return or(eq(d.g, c.value), eq(d.k, true));
    case "not":
      return not(eq(d.g, c.value));
    default: {
      const f = { eq, gt, gte, lt, lte }[c.op];
      return f(d[c.field], c.value);
    }
  }
}

function liveQuery(source: Collection<Doc, string, any>, spec: Spec) {
  return createLiveQueryCollection((q) => {
    let b = q.from({ d: source });
    const [first, ...rest] = spec.conds;
    if (first) {
      b = b.where(({ d }) => rest.reduce((all, c) => and(all, condition(c, d)), condition(first, d)));
    }
    if (!spec.order) return b;
    const { field, dir, nulls, stringSort, then, byId, anchor } = spec.order;
    if (anchor !== undefined) {
      const value = field === "n" ? anchor : STRINGS[anchor]!;
      b = b.where(({ d }) => (dir === "desc" ? lte : gte)(d[field], value));
    }
    let o = b.orderBy(({ d }) => d[field], { direction: dir, nulls, stringSort });
    if (then) o = o.orderBy(({ d }) => d[then.field], { direction: then.dir, nulls, stringSort });
    if (byId) o = o.orderBy(({ d }) => d.id, { direction: "asc", stringSort: "lexical" });
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

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

let dbs = 0;
let cases = 0;
const shapes = new Map<string, number>();

/** The options with every `loadSubset` call counted by shape, for TSDB_DIFF_REPORT. */
function counted<O extends { sync: { sync: (p: any) => any } }>(options: O): O {
  const sync = options.sync.sync;
  options.sync.sync = (params: unknown) => {
    const res = sync(params);
    if (typeof res !== "object" || !res?.loadSubset) return res;
    return {
      ...res,
      loadSubset: (o: any) => {
        const shape = [o.orderBy?.length ? "ordered" : "unordered", o.limit === undefined ? "unlimited" : "limited", o.cursor ? "cursor" : "", o.offset ? "offset" : ""];
        const key = shape.filter(Boolean).join(" ");
        shapes.set(key, (shapes.get(key) ?? 0) + 1);
        return res.loadSubset(o);
      },
    };
  };
  return options;
}

async function check(docs: readonly Doc[], specs: readonly Spec[], writes: readonly Write[], localIndex: boolean) {
  const name = `tsdb-diff-${process.pid}-${++dbs}`;
  const kvs: Db[] = [await openHarnessDb({ name, forceMemory: true, maxWalBytes: 1 << 30 })];
  kvs.push(await openHarnessDb({ name, forceMemory: true, maxWalBytes: 1 << 30 }));
  const [mine, other] = await Promise.all(kvs.map(async (kv) => (await openDocStore(kv, schema)).collection("docs")));
  await mine!.putMany(docs);
  const target = createCollection(counted(docstoreCollectionOptions({ collection: mine!, syncMode: "on-demand" })));
  if (localIndex) target.createIndex((d) => d.n, { indexType: BTreeIndex });
  const model = new Map(docs.map((d) => [d.id, d]));
  const reference = createCollection(localOnlyCollectionOptions({ getKey: (d: Doc) => d.id, initialData: [...docs] }));
  const queries = specs.map((spec) => ({ spec, got: liveQuery(target, spec), want: liveQuery(reference, spec) }));
  try {
    await Promise.all(queries.flatMap((q) => [q.got.preload(), q.want.preload()]));
    await agree(queries, "at rest");
    for (const w of writes) {
      const doc = w.fields && { id: w.id, ...w.fields };
      await write(w, doc, target, other!, model, queries.length > 1);
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
  model: Map<string, Doc>,
  shared: boolean,
) {
  switch (w.via) {
    case "transact":
      return target.utils.transact([w.id], () => [doc]);
    case "other":
      return doc ? other.putMany([doc]) : void (await other.delete(w.id));
    case "mutate":
      // An optimistic update or delete that moves a row out of an ordered window makes TanStack refill the window
      // from rows another live query loaded further down the order, without asking the source. With several
      // queries, those writes go through transact.
      if (shared && target.has(w.id)) return target.utils.transact([w.id], () => [doc]);
      if (doc && target.has(w.id)) return target.update(w.id, (draft) => Object.assign(draft, doc)).when("settled");
      if (doc) return target.insert(doc).when("settled");
      if (target.has(w.id)) return target.delete(w.id).when("settled");
      if (model.has(w.id)) return target.utils.transact([w.id], () => [null]);
  }
}

test("an on-demand live query shows what the same query shows over every document", { timeout: 600_000 }, async () => {
  const runs = Number(process.env.TSDB_DIFF_RUNS ?? 40);
  const seed = process.env.TSDB_DIFF_SEED === undefined ? undefined : Number(process.env.TSDB_DIFF_SEED);
  await fc.assert(
    fc.asyncProperty(
      docsArb,
      fc.array(specArb, { minLength: 1, maxLength: 3 }),
      fc.array(writeArb, { maxLength: 10 }),
      fc.boolean(),
      (docs, specs, writes, localIndex) => check(docs, specs, writes, localIndex),
    ),
    { numRuns: runs, ...(seed !== undefined && { seed }), endOnFailure: true },
  );
  console.log(`differential: ${cases} cases passed`);
  if (process.env.TSDB_DIFF_REPORT) console.log(Object.fromEntries([...shapes].sort()));
});

/**
 * The model test leaves unique values alone while a unique index builds. This
 * history changes them: writes from a handle on the older schema take, swap,
 * free and delete unique values between the steps of the backfill. Once the
 * store is idle, a ready unique index must hold exactly one entry per value
 * the documents hold, each pointing at the one document that holds it, and a
 * failed one must hold no entry.
 *
 * Replay a failure: DOCSTORE_UNIQUE_BUILD_SEED=<seed> DOCSTORE_UNIQUE_BUILD_PATH=<path> pnpm exec vitest run tests/unique-build-under-writes.test.ts
 * Sweep longer:     DOCSTORE_UNIQUE_BUILD_RUNS=400 pnpm exec vitest run tests/unique-build-under-writes.test.ts
 */
import type { Db } from "@opfs-lsm/kv";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { collection, defineSchema, openDocStore, type DocStore, type Schema } from "../src/index.js";
import { freshName, gate, keysUnder, openKv, storedCatalog, storedPrefix } from "./harness.js";

type Doc = { id: string; n: number; slug?: string | null | undefined; ut?: string[] | undefined };

const base = collection<Doc>().index("byN", "n");
const v1 = defineSchema({ version: 1, collections: { docs: base } });
const v2 = defineSchema({ version: 2, collections: { docs: base.unique("bySlug", "slug").unique("byUt", "ut[]") } });

const ROWS = 1_200;
const rowId = (i: number) => `r${String(i).padStart(4, "0")}`;
/** Rows on each side of the backfill's 500-row steps, and ids before and after every row. */
const HOT = ["a", rowId(0), rowId(1), rowId(499), rowId(500), rowId(501), rowId(999), rowId(1000), rowId(1199), "zz"];
const POOL = ["x", "y", "z"];

const slugArb = fc.option(fc.option(fc.constantFrom(...POOL), { nil: null, freq: 5 }), { nil: undefined, freq: 4 });
const utArb = fc.option(fc.array(fc.constantFrom(...POOL), { maxLength: 2 }), { nil: undefined, freq: 3 });
const hotArb = fc.constantFrom(...HOT);
/** "own" stands for a value no other row starts with, so most backfills meet no duplicate. */
const initialArb = fc.record({
  slug: fc.oneof({ weight: 6, arbitrary: fc.constant("own") }, { weight: 1, arbitrary: slugArb }),
  ut: fc.option(fc.array(fc.oneof({ weight: 6, arbitrary: fc.constant("own") }, { weight: 1, arbitrary: fc.constantFrom(...POOL) }), { maxLength: 2 }), {
    nil: undefined,
    freq: 3,
  }),
});

type Op =
  | { readonly kind: "put"; readonly id: string; readonly slug: string | null | undefined; readonly ut: string[] | undefined }
  | { readonly kind: "swap"; readonly a: string; readonly b: string }
  | { readonly kind: "take"; readonly from: string; readonly to: string }
  | { readonly kind: "delete"; readonly ids: readonly string[] };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("put" as const), id: hotArb, slug: slugArb, ut: utArb }),
  fc.record({ kind: fc.constant("swap" as const), a: hotArb, b: hotArb }).filter((o) => o.a !== o.b),
  fc.record({ kind: fc.constant("take" as const), from: hotArb, to: hotArb }).filter((o) => o.from !== o.to),
  fc.record({ kind: fc.constant("delete" as const), ids: fc.uniqueArray(hotArb, { minLength: 1, maxLength: 2 }) }),
);

function stored(d: Doc): Doc {
  return JSON.parse(JSON.stringify(d)) as Doc;
}

const valuesOf = (d: Doc, field: "slug" | "ut"): string[] =>
  field === "slug" ? (d.slug === undefined ? [] : [JSON.stringify(d.slug)]) : [...new Set(d.ut ?? [])].map((v) => JSON.stringify(v));

async function run(initial: readonly { slug: string | null | undefined; ut: string[] | undefined }[], steps: readonly (readonly Op[])[]) {
  const name = freshName();
  const kvs: Db[] = [];
  const kvOn = async () => {
    const kv = await openKv(name);
    kvs.push(kv);
    return kv;
  };
  const stores: DocStore<Schema>[] = [];
  try {
    const oldKv = await kvOn();
    const old = await openDocStore(oldKv, v1);
    stores.push(old as never);
    const model = new Map<string, Doc>();
    const docs: Doc[] = [];
    for (let i = 0; i < ROWS; i++) docs.push({ id: rowId(i), n: i, slug: `s${i}`, ut: [`u${i}`] });
    HOT.forEach((id, k) => {
      const i = docs.findIndex((d) => d.id === id);
      const own = initial[k]!;
      const slug = own.slug === "own" ? `h${k}` : own.slug;
      const ut = own.ut?.map((v) => (v === "own" ? `h${k}` : v));
      const doc = stored({ id, n: i < 0 ? -k : i, slug, ut });
      if (i < 0) docs.push(doc);
      else docs[i] = doc;
    });
    await old.collection("docs").putMany(docs);
    for (const d of docs) model.set(d.id, stored(d));

    const held = gate(await kvOn(), "range", 0);
    const opening = openDocStore(held.db, v2);
    let opened = false;
    void opening.then(
      () => (opened = true),
      () => (opened = true),
    );
    const c = old.collection("docs");
    for (let i = 0; i < steps.length; i++) {
      await Promise.race([held.arrived(i + 1), opening]);
      if (opened) break;
      for (const op of steps[i]!) {
        const next = new Map(model);
        let write: Promise<unknown>;
        switch (op.kind) {
          case "put": {
            const doc = stored({ id: op.id, n: model.get(op.id)?.n ?? 0, slug: op.slug, ut: op.ut });
            next.set(op.id, doc);
            write = c.put(doc);
            break;
          }
          case "swap":
          case "take": {
            const [p, q] = op.kind === "swap" ? [op.a, op.b] : [op.from, op.to];
            const fn = ([x, y]: readonly (Doc | undefined)[]): (Doc | null | undefined)[] =>
              op.kind === "swap"
                ? [x && y ? { ...x, slug: y.slug, ut: y.ut } : undefined, x && y ? { ...y, slug: x.slug, ut: x.ut } : undefined]
                : [x ? null : undefined, x ? { ...(y ?? { id: q, n: 0 }), id: q, slug: x.slug, ut: x.ut } : undefined];
            const out = fn([model.get(p), model.get(q)]);
            out.forEach((d, k) => {
              const id = k === 0 ? p : q;
              if (d === null) next.delete(id);
              else if (d) next.set(id, stored(d));
            });
            write = c.modifyMany([p, q], fn);
            break;
          }
          case "delete":
            for (const id of op.ids) next.delete(id);
            write = c.deleteMany(op.ids);
            break;
        }
        try {
          await write;
          for (const k of [...model.keys()]) if (!next.has(k)) model.delete(k);
          for (const [k, v] of next) model.set(k, v);
        } catch (err) {
          if ((err as { code?: unknown }).code !== "unique") throw err;
        }
      }
      held.release(1);
    }
    held.release();
    const store = await opening;
    stores.push(store as never);
    await Promise.all(stores.map((s) => s.whenIdle()));
    const kv = kvs[1]!;
    await kv.sync();

    const read = store.collection("docs");
    expect((await read.query({})).docs).toEqual([...model.values()].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)));
    const catalog = await storedCatalog(kv);
    for (const [index, field] of [
      ["bySlug", "slug"],
      ["byUt", "ut"],
    ] as const) {
      const state = catalog.collections["docs"]!.indexes[index]!.state.kind;
      if (state !== "ready") {
        expect(state).toBe("failed");
        continue;
      }
      const holders = new Map<string, string[]>();
      for (const d of model.values()) for (const v of valuesOf(d, field)) holders.set(v, [...(holders.get(v) ?? []), d.id]);
      const shared = [...holders].filter(([, ids]) => ids.length > 1);
      expect([index, "documents sharing a value", shared]).toEqual([index, "documents sharing a value", []]);
      const entries = (await read.queryEntries({ index } as never)).entries.map((e) => [JSON.stringify(e.values[0]), e.id]);
      expect([index, entries.sort()]).toEqual([index, [...holders].map(([v, ids]) => [v, ids[0]]).sort()]);
      expect(await keysUnder(kv, await storedPrefix(kv, "docs", index))).toBe(holders.size);
    }
  } finally {
    await Promise.allSettled(stores.map((s) => s.whenIdle()));
    await Promise.all(kvs.map((kv) => kv.close()));
  }
}

const env = process.env;
const replay = env["DOCSTORE_UNIQUE_BUILD_SEED"]
  ? { seed: Number(env["DOCSTORE_UNIQUE_BUILD_SEED"]), ...(env["DOCSTORE_UNIQUE_BUILD_PATH"] ? { path: env["DOCSTORE_UNIQUE_BUILD_PATH"] } : {}) }
  : {};

describe("unique values that change while their unique index builds", () => {
  it(
    "leave a ready unique index with exactly one entry per value, held by the one document that holds it",
    async () => {
      await expect(
        fc.assert(
          fc.asyncProperty(
            fc.array(initialArb, { minLength: HOT.length, maxLength: HOT.length }),
            fc.array(fc.array(opArb, { maxLength: 4 }), { minLength: 1, maxLength: 6 }),
            run,
          ),
          { numRuns: Number(env["DOCSTORE_UNIQUE_BUILD_RUNS"] ?? 40), ...replay },
        ),
      ).resolves.toBeUndefined();
    },
    300_000,
  );
});

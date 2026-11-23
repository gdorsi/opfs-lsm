/**
 * Random histories of writes, clears, reads, ingests, reopens and schema
 * upgrades on one database, checked against an in-memory map of the
 * documents. An upgrade adds or removes a unique multi index, and the handle
 * on the version before it stays open and keeps writing. A reader that
 * follows the change feed from a snapshot must end up with the same map.
 *
 * Replay a failure: DOCSTORE_MODEL_SEED=<seed> DOCSTORE_MODEL_PATH=<path> pnpm exec vitest run tests/model.test.ts
 * Sweep longer:     DOCSTORE_MODEL_RUNS=2000 pnpm exec vitest run tests/model.test.ts
 */
import type { Db } from "@opfs-lsm/kv";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { defineSchema, openDocStore, type DocStore } from "../src/index.js";
import type { QueryInput, Scalar } from "../src/schema.js";
import { ARITY, MODEL, UNIQUE_TAGS, checkQuery, queryArbOn, schema, textArb, withUniqueTags, type Doc } from "./docs.js";
import { mirror } from "./mirror.js";
import { codeOf, docstoreKeys, freshName, openKv, storedCatalog } from "./harness.js";
import { expected, stored } from "./oracle.js";
import { denseScalarArb } from "./order.js";
import { ingest } from "@opfs-lsm/kv/testing";

const env = process.env;
const RUNS = Number(env["DOCSTORE_MODEL_RUNS"] ?? 100);
const replay = env["DOCSTORE_MODEL_SEED"]
  ? { seed: Number(env["DOCSTORE_MODEL_SEED"]), ...(env["DOCSTORE_MODEL_PATH"] ? { path: env["DOCSTORE_MODEL_PATH"] } : {}) }
  : {};

/** `previous`: through the handle on the version before the last upgrade, when one is open. */
type Cmd = (
  | { readonly kind: "putMany"; readonly docs: readonly Doc[] }
  | { readonly kind: "modify"; readonly id: string; readonly patch: Partial<Doc> }
  | { readonly kind: "modifyMany"; readonly slots: readonly Slot[] }
  | { readonly kind: "deleteMany"; readonly ids: readonly string[] }
  | { readonly kind: "clear" }
  | { readonly kind: "query"; readonly index: string | undefined; readonly q: QueryInput; readonly page: number }
  | { readonly kind: "getMany"; readonly ids: readonly string[] }
  | { readonly kind: "ingest" }
  | { readonly kind: "reopen"; readonly idle: boolean }
  | { readonly kind: "upgrade"; readonly utags: boolean }
) & { readonly previous: boolean };

/** The model's schema at `version`, with the unique multi index or without it. Typed as `schema`: queries name the index at run time. */
const schemaAt = (version: number, utags: boolean) =>
  defineSchema({ version, collections: { docs: utags ? withUniqueTags : schema.collections.docs } }) as unknown as typeof schema;
type Store = DocStore<typeof schema>;

/** ready: declared and built. failed: declared, and its backfill met two documents sharing an element. */
type UniqueTags = "absent" | "ready" | "failed";

/** What one slot of a `modifyMany` call does to its document. */
type Slot = { readonly id: string; readonly act: "set" | "delete" | "leave"; readonly patch: Partial<Doc> };

const ids = fc.constantFrom("a", "aa", "ab", "b", "\u0000", "a\u0000", "\ufeffa", "😀", "z");
const uArb = fc.option(fc.constantFrom<Scalar>(null, true, 1, -0, "x", "y"), { nil: undefined });
const tagArb = fc.constantFrom<Scalar>(null, true, 1, "a", "b", "ab");
const fields = {
  a: fc.option(denseScalarArb, { nil: undefined }),
  b: fc.option(denseScalarArb, { nil: undefined }),
  tags: fc.option(fc.array(denseScalarArb, { maxLength: 4 }), { nil: undefined }),
  u: uArb,
  t: fc.option(fc.option(textArb, { nil: null, freq: 6 }), { nil: undefined }),
  ut: fc.option(fc.array(tagArb, { maxLength: 3 }), { nil: undefined }),
};
const docArb: fc.Arbitrary<Doc> = fc.record({ id: ids, ...fields }, { requiredKeys: ["id"] });

const opArb = fc.oneof(
  { weight: 6, arbitrary: fc.uniqueArray(docArb, { selector: (d) => d.id, minLength: 1, maxLength: 4 }).map((docs) => ({ kind: "putMany" as const, docs })) },
  { weight: 3, arbitrary: fc.record({ id: ids, patch: fc.record(fields, { requiredKeys: [] }) }).map((m) => ({ kind: "modify" as const, ...m })) },
  {
    weight: 3,
    arbitrary: fc
      .uniqueArray(
        fc.record({ id: ids, act: fc.constantFrom("set", "set", "delete", "leave"), patch: fc.record(fields, { requiredKeys: [] }) }),
        { selector: (s) => s.id, minLength: 1, maxLength: 4 },
      )
      .map((slots) => ({ kind: "modifyMany" as const, slots })),
  },
  { weight: 2, arbitrary: fc.array(ids, { minLength: 1, maxLength: 3 }).map((ids) => ({ kind: "deleteMany" as const, ids })) },
  { weight: 1, arbitrary: fc.constant({ kind: "clear" as const }) },
  {
    weight: 5,
    arbitrary: fc
      .tuple(queryArbOn({ ...ARITY, [UNIQUE_TAGS.name]: UNIQUE_TAGS.arity }), fc.integer({ min: 1, max: 5 }))
      .map(([{ index, q }, page]) => ({ kind: "query" as const, index, q, page })),
  },
  { weight: 1, arbitrary: fc.array(ids, { maxLength: 3 }).map((ids) => ({ kind: "getMany" as const, ids })) },
  { weight: 1, arbitrary: fc.constant({ kind: "ingest" as const }) },
  { weight: 1, arbitrary: fc.boolean().map((idle) => ({ kind: "reopen" as const, idle })) },
  { weight: 2, arbitrary: fc.boolean().map((utags) => ({ kind: "upgrade" as const, utags })) },
);
const cmdArb: fc.Arbitrary<Cmd> = fc.tuple(opArb, fc.boolean()).map(([op, previous]) => ({ ...op, previous }));

/** Whether two documents share `u`, or, when `utags` counts, an element of `ut`. */
function sharesUniqueIn(docs: Iterable<Doc>, utags: boolean): boolean {
  const seen = new Set<string>();
  for (const d of docs) {
    const values = d.u === undefined ? [] : [`u ${JSON.stringify(d.u)}`];
    if (utags && d.ut !== undefined) {
      for (const t of new Set(d.ut)) values.push(`ut ${JSON.stringify(t)}`);
    }
    for (const k of values) {
      if (seen.has(k)) return true;
      seen.add(k);
    }
  }
  return false;
}

/** `declared`: the first schema already declares the unique multi index. */
async function run(declared: boolean, cmds: readonly Cmd[]): Promise<void> {
  const name = freshName();
  let kv: Db = await openKv(name);
  let version = 1;
  let utags: UniqueTags = declared ? "ready" : "absent";
  let store: Store = await openDocStore(kv, schemaAt(version, declared));
  let previous: Store | undefined;
  let model = new Map<string, Doc>();
  const c = () => store.collection("docs");
  let reader = mirror(c());
  try {
    for (const cmd of cmds) {
      const sharesUnique = (docs: Iterable<Doc>) => sharesUniqueIn(docs, utags === "ready");
      const writer = cmd.previous && previous ? previous : store;
      const w = () => writer.collection("docs");
      switch (cmd.kind) {
        case "putMany": {
          const next = new Map(model);
          for (const d of cmd.docs) next.set(d.id, stored(d));
          if (sharesUnique(next.values())) {
            expect(await codeOf(w().putMany(cmd.docs))).toBe("unique");
          } else {
            await w().putMany(cmd.docs);
            model = next;
          }
          break;
        }
        case "modify": {
          const old = model.get(cmd.id);
          const fn = (d: Doc): Doc => ({ ...d, ...cmd.patch, id: d.id });
          if (!old) {
            expect(await w().modify(cmd.id, fn)).toBeUndefined();
            break;
          }
          const doc = stored(fn(old));
          const next = new Map(model).set(cmd.id, doc);
          if (sharesUnique(next.values())) {
            expect(await codeOf(w().modify(cmd.id, fn))).toBe("unique");
          } else {
            expect(await w().modify(cmd.id, fn)).toEqual(doc);
            model = next;
          }
          break;
        }
        case "modifyMany": {
          const ids = cmd.slots.map((s) => s.id);
          const next = new Map(model);
          const results = cmd.slots.map((s) => {
            if (s.act === "leave") return undefined;
            if (s.act === "delete") return null;
            return { ...next.get(s.id), ...s.patch, id: s.id } as Doc;
          });
          results.forEach((r, i) => {
            if (r === null) next.delete(ids[i]!);
            else if (r) next.set(ids[i]!, stored(r));
          });
          let given: readonly (Doc | undefined)[] = [];
          const fn = (docs: readonly (Doc | undefined)[]) => {
            given = structuredClone(docs);
            return results;
          };
          if (sharesUnique(next.values())) {
            expect(await codeOf(w().modifyMany(ids, fn))).toBe("unique");
          } else {
            await w().modifyMany(ids, fn);
            expect(given).toEqual(ids.map((id) => model.get(id)));
            model = next;
          }
          break;
        }
        case "deleteMany": {
          const distinct = new Set(cmd.ids);
          expect(await w().deleteMany(cmd.ids)).toBe([...distinct].filter((id) => model.has(id)).length);
          for (const id of distinct) model.delete(id);
          break;
        }
        case "clear":
          await w().clear();
          model = new Map();
          break;
        case "query": {
          const docs = [...model.values()];
          if (cmd.index !== UNIQUE_TAGS.name) {
            await checkQuery(w(), docs, cmd.index, cmd.q, cmd.page);
            await w().view((snap) => checkQuery(snap, docs, cmd.index, cmd.q, cmd.page));
          } else if (utags === "ready") {
            const indexes = { [UNIQUE_TAGS.name]: UNIQUE_TAGS.model };
            await checkQuery(c(), docs, cmd.index, cmd.q, cmd.page, indexes);
            await c().view((snap) => checkQuery(snap, docs, cmd.index, cmd.q, cmd.page, indexes));
          } else {
            expect(await codeOf(c().queryIds(cmd.q as never))).toBe(utags === "failed" ? "index-failed" : "schema");
          }
          break;
        }
        case "getMany":
          expect(await w().getMany(cmd.ids)).toEqual(cmd.ids.map((id) => model.get(id)));
          break;
        case "ingest":
          await ingest(kv);
          break;
        case "reopen":
          if (cmd.idle) await Promise.all([store.whenIdle(), previous?.whenIdle()]);
          reader.stop();
          await kv.close();
          kv = await openKv(name);
          store = await openDocStore(kv, schemaAt(version, utags !== "absent"));
          previous = undefined;
          reader = mirror(c());
          break;
        case "upgrade":
          previous = store;
          store = await openDocStore(kv, schemaAt(++version, cmd.utags));
          if (!cmd.utags) utags = "absent";
          else if (utags !== "ready") utags = sharesUniqueIn(model.values(), true) ? "failed" : "ready";
          break;
      }
    }
    await reader.reaches(model);
    await Promise.all([store.whenIdle(), previous?.whenIdle()]);
    const docs = [...model.values()];
    const indexes = utags === "ready" ? [...Object.values(MODEL), UNIQUE_TAGS.model] : Object.values(MODEL);
    const entries = indexes.reduce((n, ix) => n + expected(docs, ix, {}).length, 0);
    expect((await storedCatalog(kv)).dropped).toEqual([]);
    expect((await docstoreKeys(kv)).length).toBe(1 + docs.length + entries);
  } finally {
    await Promise.all([store.whenIdle(), previous?.whenIdle()]).catch(() => undefined);
    await kv.close();
  }
}

describe("docstore against an in-memory model", () => {
  it(
    "agrees on every read, and leaves exactly the catalog, the rows and their entries in kv",
    async () => {
      await expect(
        fc.assert(fc.asyncProperty(fc.boolean(), fc.array(cmdArb, { maxLength: 40 }), run), { numRuns: RUNS, ...replay }),
      ).resolves.toBeUndefined();
    },
    Math.max(60_000, RUNS * 300),
  );
});

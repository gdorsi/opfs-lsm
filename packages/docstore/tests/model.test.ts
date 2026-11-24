/**
 * Random histories of writes, clears, reads, ingests, reopens and schema
 * upgrades on one database, checked against an in-memory map of the
 * documents. An upgrade declares any subset of the indexes, so it adds,
 * keeps, rebuilds and removes indexes of every kind, while a handle on an
 * older version may write during its backfills. The handle on the version
 * before it stays open and keeps writing. A second kv handle,
 * like a tab that hears of the others' writes only when it reads, writes and
 * reads too. A reader that follows the change feed from a snapshot must end
 * up with the same map.
 *
 * Replay a failure: DOCSTORE_MODEL_SEED=<seed> DOCSTORE_MODEL_PATH=<path> pnpm exec vitest run tests/model.test.ts
 * Sweep longer:     DOCSTORE_MODEL_RUNS=2000 pnpm exec vitest run tests/model.test.ts
 */
import type { Db } from "@opfs-lsm/kv";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { collection, defineSchema, openDocStore, type CollectionDecl, type DocStore } from "../src/index.js";
import type { QueryInput, Scalar } from "../src/schema.js";
import { ARITY, MODEL, UNIQUE_TAGS, checkQuery, queryArbOn, schema, textArb, withUniqueTags, type Doc } from "./docs.js";
import { mirror } from "./mirror.js";
import { codeOf, docstoreKeys, freshName, keysUnder, openKv, storedCatalog, storedPrefix } from "./harness.js";
import { expected, stored, type ModelIndex } from "./oracle.js";
import { denseScalarArb } from "./order.js";
import { ingest } from "@opfs-lsm/kv/testing";

const env = process.env;
const RUNS = Number(env["DOCSTORE_MODEL_RUNS"] ?? 100);
const replay = env["DOCSTORE_MODEL_SEED"]
  ? { seed: Number(env["DOCSTORE_MODEL_SEED"]), ...(env["DOCSTORE_MODEL_PATH"] ? { path: env["DOCSTORE_MODEL_PATH"] } : {}) }
  : {};

/**
 * A write during an upgrade, made `wait` ms after the one before it. It leaves
 * `u` and `ut` alone, so whether a unique backfill fails does not depend on
 * when the write lands.
 */
type Patch = Pick<Doc, "id" | "a" | "b" | "tags" | "t"> & { readonly wait: number };

/**
 * `previous`: through the handle on the version before the last upgrade, when one is open. `tab`: through the second kv handle.
 * An upgrade declares the indexes `names`, while the handle the flags pick writes `during`.
 */
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
  | { readonly kind: "upgrade"; readonly names: readonly string[]; readonly during: readonly Patch[] }
) & { readonly previous: boolean; readonly tab: boolean };

type IndexDecl = {
  readonly by: string | readonly string[];
  readonly unique?: true;
  readonly text?: string;
  readonly include?: readonly string[];
};
const DECLS = withUniqueTags.indexes as unknown as Record<string, IndexDecl>;
const NAMES = Object.keys(DECLS);
const MODELS: Record<string, ModelIndex> = { ...MODEL, [UNIQUE_TAGS.name]: UNIQUE_TAGS.model };

/** The collection with the indexes `names`, declared through `collection` as an app declares it. */
function declare(names: readonly string[]): CollectionDecl<Doc> {
  type Loose = { readonly [K in "index" | "unique" | "text"]: (...args: unknown[]) => Loose };
  let d = collection<Doc>() as unknown as Loose;
  for (const n of names) {
    const { by, unique, text, include } = DECLS[n]!;
    d = unique ? d.unique(n, by) : text ? d.text(n, by, text) : include ? d.index(n, by, { include }) : d.index(n, by);
  }
  return d as unknown as CollectionDecl<Doc>;
}

/** The model's schema at `version` with the indexes `names`. Typed as `schema`: queries name the index at run time. */
const schemaAt = (version: number, names: readonly string[]) =>
  defineSchema({ version, collections: { docs: declare(names) } }) as unknown as typeof schema;
type Store = DocStore<typeof schema>;

/** An index of the stored catalog. failed: its backfill met two documents sharing a unique value. */
type IndexState = "ready" | "failed";

/** What one slot of a `modifyMany` call does to its document. */
type Slot = { readonly id: string; readonly act: "set" | "delete" | "leave"; readonly patch: Partial<Doc> };

const ids = fc.constantFrom("a", "aa", "ab", "b", "\u0000", "a\u0000", "﻿a", "😀", "z");
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
const patchArb: fc.Arbitrary<Patch> = fc.record(
  { id: ids, a: fields.a, b: fields.b, tags: fields.tags, t: fields.t, wait: fc.integer({ min: 0, max: 3 }) },
  { requiredKeys: ["id", "wait"] },
);

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
  {
    weight: 2,
    arbitrary: fc
      .record({
        names: fc.subarray(NAMES),
        during: fc.oneof(fc.constant([]), fc.uniqueArray(patchArb, { selector: (p) => p.id, minLength: 1, maxLength: 4 })),
      })
      .map((u) => ({ kind: "upgrade" as const, ...u })),
  },
);
const cmdArb: fc.Arbitrary<Cmd> = fc.tuple(opArb, fc.boolean(), fc.boolean()).map(([op, previous, tab]) => ({ ...op, previous, tab }));

/** Whether two documents share `u` while `uniq` counts, or an element of `ut` while `utags` counts. */
function sharesUniqueIn(docs: Iterable<Doc>, unique: ReadonlySet<string>): boolean {
  const seen = new Set<string>();
  for (const d of docs) {
    const values = unique.has("uniq") && d.u !== undefined ? [`u ${JSON.stringify(d.u)}`] : [];
    if (unique.has(UNIQUE_TAGS.name) && d.ut !== undefined) {
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
  const first = declared ? NAMES : NAMES.filter((n) => n !== UNIQUE_TAGS.name);
  let kv: Db = await openKv(name);
  let version = 1;
  /** The indexes of the stored catalog. */
  let catalog = new Map<string, IndexState>(first.map((n) => [n, "ready"]));
  let store: Store = await openDocStore(kv, schemaAt(version, first));
  let storeNames: readonly string[] = first;
  let tabKv: Db = await openKv(name);
  let tab: Store = await openDocStore(tabKv, schemaAt(version, first));
  let tabNames: readonly string[] = first;
  let previous: Store | undefined;
  let previousNames: readonly string[] = first;
  let model = new Map<string, Doc>();
  const c = () => store.collection("docs");
  let reader = mirror(c());
  try {
    for (const cmd of cmds) {
      const unique = new Set([...catalog].flatMap(([n, s]) => (s === "ready" && DECLS[n]!.unique ? [n] : [])));
      const sharesUnique = (docs: Iterable<Doc>) => sharesUniqueIn(docs, unique);
      if (cmd.kind === "query" || cmd.kind === "getMany") {
        await kv.sync();
        await tabKv.sync();
      }
      const writer = cmd.tab ? tab : cmd.previous && previous ? previous : store;
      const writerNames = cmd.tab ? tabNames : cmd.previous && previous ? previousNames : storeNames;
      const w = () => writer.collection("docs");
      if (cmd.tab && cmd.kind === "ingest") {
        await ingest(tabKv);
        continue;
      }
      if (cmd.tab && cmd.kind === "reopen") {
        await tab.whenIdle();
        await tabKv.close();
        tabKv = await openKv(name);
        tab = await openDocStore(tabKv, schemaAt(version, storeNames));
        tabNames = storeNames;
        continue;
      }
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
          const state = cmd.index === undefined ? "ready" : writerNames.includes(cmd.index) ? catalog.get(cmd.index) : undefined;
          if (state === "ready") {
            await checkQuery(w(), docs, cmd.index, cmd.q, cmd.page, MODELS);
            await w().view((snap) => checkQuery(snap, docs, cmd.index, cmd.q, cmd.page, MODELS));
          } else {
            expect(await codeOf(w().queryIds(cmd.q as never))).toBe(state === "failed" ? "index-failed" : "schema");
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
          store = await openDocStore(kv, schemaAt(version, storeNames));
          previous = undefined;
          reader = mirror(c());
          break;
        case "upgrade": {
          const built = cmd.names.filter((n) => catalog.get(n) !== "ready");
          const failing = built.filter((n) => DECLS[n]!.unique && sharesUniqueIn(model.values(), new Set([n])));
          const opening = openDocStore(kv, schemaAt(version + 1, cmd.names));
          const writes = (async () => {
            for (const { wait, ...patch } of cmd.during) {
              await new Promise((r) => setTimeout(r, wait));
              const doc = stored({ ...model.get(patch.id), ...patch });
              try {
                await w().putMany([doc]);
                model.set(doc.id, doc);
              } catch (err) {
                // A write while a unique index builds over a value two documents share may meet the owner the backfill gave that value.
                if (failing.length === 0 || (err as { code?: unknown }).code !== "unique") throw err;
              }
            }
          })();
          const [opened, wrote] = await Promise.allSettled([opening, writes]);
          if (opened.status === "rejected") throw opened.reason;
          if (wrote.status === "rejected") throw wrote.reason;
          catalog = new Map(cmd.names.map((n) => [n, failing.includes(n) ? "failed" : "ready"]));
          version++;
          previous = store;
          previousNames = storeNames;
          store = opened.value;
          storeNames = cmd.names;
          break;
        }
      }
    }
    await Promise.all([store.whenIdle(), previous?.whenIdle(), tab.whenIdle()]);
    await kv.sync();
    await reader.reaches(model);
    await Promise.all([store.whenIdle(), previous?.whenIdle()]);
    const docs = [...model.values()];
    const kept = await storedCatalog(kv);
    expect(kept.dropped).toEqual([]);
    const states = Object.entries(kept.collections["docs"]!.indexes).map(([n, i]) => [n, i.state.kind]);
    expect(Object.fromEntries(states)).toEqual(Object.fromEntries(catalog));
    let entries = 0;
    for (const [n, state] of catalog) {
      const have = await keysUnder(kv, await storedPrefix(kv, "docs", n));
      expect([n, have]).toEqual([n, state === "failed" ? 0 : expected(docs, MODELS[n]!, {}).length]);
      entries += have;
    }
    expect((await docstoreKeys(kv)).length).toBe(1 + docs.length + entries);
  } finally {
    await Promise.all([store.whenIdle(), previous?.whenIdle(), tab.whenIdle()]).catch(() => undefined);
    await tabKv.close();
    await kv.close();
  }
}

describe("docstore against an in-memory model", () => {
  it(
    "agrees on every read, and leaves exactly the catalog, the rows and their entries in kv",
    async () => {
      await expect(
        fc.assert(fc.asyncProperty(fc.boolean(), fc.array(cmdArb, { maxLength: 40, size: "max" }), run), { numRuns: RUNS, ...replay }),
      ).resolves.toBeUndefined();
    },
    Math.max(60_000, RUNS * 300),
  );
});

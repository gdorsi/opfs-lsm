/**
 * Random histories of writes, clears, reads, ingests and reopens on one
 * database, checked against an in-memory map of the documents. A reader that
 * follows the change feed from a snapshot must end up with the same map.
 *
 * Replay a failure: DOCSTORE_MODEL_SEED=<seed> DOCSTORE_MODEL_PATH=<path> pnpm exec vitest run tests/model.test.ts
 * Sweep longer:     DOCSTORE_MODEL_RUNS=2000 pnpm exec vitest run tests/model.test.ts
 */
import type { Db } from "@opfs-lsm/kv";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { openDocStore, type DocStore } from "../src/index.js";
import type { QueryInput, Scalar } from "../src/schema.js";
import { MODEL, checkQuery, queryArb, schema, textArb, type Doc } from "./docs.js";
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

type Cmd =
  | { readonly kind: "putMany"; readonly docs: readonly Doc[] }
  | { readonly kind: "modify"; readonly id: string; readonly patch: Partial<Doc> }
  | { readonly kind: "modifyMany"; readonly slots: readonly Slot[] }
  | { readonly kind: "deleteMany"; readonly ids: readonly string[] }
  | { readonly kind: "clear" }
  | { readonly kind: "query"; readonly index: string | undefined; readonly q: QueryInput; readonly page: number }
  | { readonly kind: "getMany"; readonly ids: readonly string[] }
  | { readonly kind: "ingest" }
  | { readonly kind: "reopen"; readonly idle: boolean };

/** What one slot of a `modifyMany` call does to its document. */
type Slot = { readonly id: string; readonly act: "set" | "delete" | "leave"; readonly patch: Partial<Doc> };

const ids = fc.constantFrom("a", "aa", "ab", "b", "\u0000", "a\u0000", "😀", "z");
const uArb = fc.option(fc.constantFrom<Scalar>(null, true, 1, -0, "x", "y"), { nil: undefined });
const fields = {
  a: fc.option(denseScalarArb, { nil: undefined }),
  b: fc.option(denseScalarArb, { nil: undefined }),
  tags: fc.option(fc.array(denseScalarArb, { maxLength: 4 }), { nil: undefined }),
  u: uArb,
  t: fc.option(textArb, { nil: undefined }),
};
const docArb: fc.Arbitrary<Doc> = fc.record({ id: ids, ...fields }, { requiredKeys: ["id"] });

const cmdArb: fc.Arbitrary<Cmd> = fc.oneof(
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
  { weight: 5, arbitrary: fc.tuple(queryArb, fc.integer({ min: 1, max: 5 })).map(([{ index, q }, page]) => ({ kind: "query" as const, index, q, page })) },
  { weight: 1, arbitrary: fc.array(ids, { maxLength: 3 }).map((ids) => ({ kind: "getMany" as const, ids })) },
  { weight: 1, arbitrary: fc.constant({ kind: "ingest" as const }) },
  { weight: 1, arbitrary: fc.boolean().map((idle) => ({ kind: "reopen" as const, idle })) },
);

function sharesUnique(docs: Iterable<Doc>): boolean {
  const seen = new Set<string>();
  for (const d of docs) {
    if (d.u === undefined) continue;
    const k = JSON.stringify(d.u);
    if (seen.has(k)) return true;
    seen.add(k);
  }
  return false;
}

async function run(cmds: readonly Cmd[]): Promise<void> {
  const name = freshName();
  let kv: Db = await openKv(name);
  let store: DocStore<typeof schema> = await openDocStore(kv, schema);
  let model = new Map<string, Doc>();
  const c = () => store.collection("docs");
  let reader = mirror(c());
  try {
    for (const cmd of cmds) {
      switch (cmd.kind) {
        case "putMany": {
          const next = new Map(model);
          for (const d of cmd.docs) next.set(d.id, stored(d));
          if (sharesUnique(next.values())) {
            expect(await codeOf(c().putMany(cmd.docs))).toBe("unique");
          } else {
            await c().putMany(cmd.docs);
            model = next;
          }
          break;
        }
        case "modify": {
          const old = model.get(cmd.id);
          const fn = (d: Doc): Doc => ({ ...d, ...cmd.patch, id: d.id });
          if (!old) {
            expect(await c().modify(cmd.id, fn)).toBeUndefined();
            break;
          }
          const doc = stored(fn(old));
          const next = new Map(model).set(cmd.id, doc);
          if (sharesUnique(next.values())) {
            expect(await codeOf(c().modify(cmd.id, fn))).toBe("unique");
          } else {
            expect(await c().modify(cmd.id, fn)).toEqual(doc);
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
            expect(await codeOf(c().modifyMany(ids, fn))).toBe("unique");
          } else {
            await c().modifyMany(ids, fn);
            expect(given).toEqual(ids.map((id) => model.get(id)));
            model = next;
          }
          break;
        }
        case "deleteMany": {
          const distinct = new Set(cmd.ids);
          expect(await c().deleteMany(cmd.ids)).toBe([...distinct].filter((id) => model.has(id)).length);
          for (const id of distinct) model.delete(id);
          break;
        }
        case "clear":
          await c().clear();
          model = new Map();
          break;
        case "query":
          await checkQuery(c(), [...model.values()], cmd.index, cmd.q, cmd.page);
          await c().view((snap) => checkQuery(snap, [...model.values()], cmd.index, cmd.q, cmd.page));
          break;
        case "getMany":
          expect(await c().getMany(cmd.ids)).toEqual(cmd.ids.map((id) => model.get(id)));
          break;
        case "ingest":
          await ingest(kv);
          break;
        case "reopen":
          if (cmd.idle) await store.whenIdle();
          reader.stop();
          await kv.close();
          kv = await openKv(name);
          store = await openDocStore(kv, schema);
          reader = mirror(c());
          break;
      }
    }
    await reader.reaches(model);
    await store.whenIdle();
    const docs = [...model.values()];
    const entries = Object.values(MODEL).reduce((n, ix) => n + expected(docs, ix, {}).length, 0);
    expect((await storedCatalog(kv)).dropped).toEqual([]);
    expect((await docstoreKeys(kv)).length).toBe(1 + docs.length + entries);
  } finally {
    await store.whenIdle().catch(() => undefined);
    await kv.close();
  }
}

describe("docstore against an in-memory model", () => {
  it(
    "agrees on every read, and leaves exactly the catalog, the rows and their entries in kv",
    async () => {
      await expect(
        fc.assert(fc.asyncProperty(fc.array(cmdArb, { maxLength: 40 }), (cmds) => run(cmds)), { numRuns: RUNS, ...replay }),
      ).resolves.toBeUndefined();
    },
    Math.max(60_000, RUNS * 300),
  );
});

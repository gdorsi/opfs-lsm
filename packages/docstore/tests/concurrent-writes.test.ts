/**
 * the model test awaits each write before the next. Here writes from
 * three kv handles (one without the broadcast bus) run at once, with clears
 * and a schema upgrade that adds indexes in flight. Whatever order kv picks,
 * once everything settles every index must hold exactly the entries of the
 * rows, every handle must read the same rows, a change-feed mirror must reach
 * them, and a snapshot must read one state for its whole body.
 *
 * Replay: DOCSTORE_CONCURRENT_SEED=<seed> DOCSTORE_CONCURRENT_PATH=<path> pnpm exec vitest run tests/concurrent-writes.test.ts
 */
import type { Db } from "@opfs-lsm/kv";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { collection, defineSchema, openDocStore, type DocStore } from "../src/index.js";
import type { Scalar } from "../src/schema.js";
import { MODEL, checkQuery, schema, textArb, type Doc } from "./docs.js";
import { docstoreKeys, freshName, keysUnder, openKv, openKvWithoutBus, storedCatalog, storedPrefix } from "./harness.js";
import { mirror } from "./mirror.js";
import { expected } from "./oracle.js";
import { denseScalarArb } from "./order.js";

const env = process.env;
const replay = env["DOCSTORE_CONCURRENT_SEED"] ? { seed: Number(env["DOCSTORE_CONCURRENT_SEED"]), ...(env["DOCSTORE_CONCURRENT_PATH"] ? { path: env["DOCSTORE_CONCURRENT_PATH"] } : {}) } : {};

const v1 = defineSchema({
  version: 1,
  collections: { docs: collection<Doc>().index("one", "a").index("tags", ["tags[]", "b"]) },
}) as unknown as typeof schema;
const v2 = { ...schema, version: 2 } as typeof schema;
type Store = DocStore<typeof schema>;

const ids = fc.constantFrom("a", "ab", "b", "\u0000", "😀", "z", "a\u0000");
/** `u` is a function of the id, so no write meets a unique conflict whatever order kv picks. */
const withU = (d: Doc): Doc => (d.u === undefined ? d : { ...d, u: `u:${d.id}` });
const fields = {
  a: fc.option(denseScalarArb, { nil: undefined }),
  b: fc.option(denseScalarArb, { nil: undefined }),
  tags: fc.option(fc.array(denseScalarArb, { maxLength: 3 }), { nil: undefined }),
  u: fc.option(fc.constant<Scalar>(1), { nil: undefined }),
  t: fc.option(fc.option(textArb, { nil: null }), { nil: undefined }),
};
const docArb = fc.record({ id: ids, ...fields }, { requiredKeys: ["id"] }).map(withU);

type Op =
  | { kind: "putMany"; docs: Doc[] }
  | { kind: "modify"; id: string; patch: Partial<Doc> }
  | { kind: "modifyMany"; ids: string[]; del: boolean[] }
  | { kind: "deleteMany"; ids: string[] }
  | { kind: "clear" }
  | { kind: "view" }
  | { kind: "upgrade" };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 6, arbitrary: fc.uniqueArray(docArb, { selector: (d) => d.id, minLength: 1, maxLength: 4 }).map((docs) => ({ kind: "putMany" as const, docs })) },
  { weight: 3, arbitrary: fc.record({ id: ids, patch: fc.record(fields, { requiredKeys: [] }) }).map((m) => ({ kind: "modify" as const, ...m })) },
  {
    weight: 2,
    arbitrary: fc
      .uniqueArray(ids, { minLength: 1, maxLength: 3 })
      .chain((ids) => fc.array(fc.boolean(), { minLength: ids.length, maxLength: ids.length }).map((del) => ({ kind: "modifyMany" as const, ids, del }))),
  },
  { weight: 2, arbitrary: fc.array(ids, { minLength: 1, maxLength: 3 }).map((ids) => ({ kind: "deleteMany" as const, ids })) },
  { weight: 1, arbitrary: fc.constant({ kind: "clear" as const }) },
  { weight: 2, arbitrary: fc.constant({ kind: "view" as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: "upgrade" as const }) },
);

/** An op, the handle that runs it, and how long it waits before it starts. */
const stepArb = fc.record({ op: opArb, by: fc.integer({ min: 0, max: 2 }), wait: fc.integer({ min: 0, max: 3 }) });

async function run(steps: readonly { op: Op; by: number; wait: number }[]): Promise<void> {
  const name = freshName();
  const kvs: Db[] = [await openKv(name), await openKv(name), await openKvWithoutBus(name)];
  const stores: Store[] = [];
  for (const kv of kvs) stores.push(await openDocStore(kv, v1));
  const upgraded: Store[] = [];
  const reader = mirror(stores[0]!.collection("docs"));
  try {
    const runs = steps.map(async ({ op, by, wait }) => {
      await new Promise((r) => setTimeout(r, wait));
      const c = stores[by]!.collection("docs");
      switch (op.kind) {
        case "putMany":
          return c.putMany(op.docs);
        case "modify":
          return c.modify(op.id, (d) => withU({ ...d, ...op.patch, id: d.id }));
        case "modifyMany":
          return c.modifyMany(op.ids, (docs) => docs.map((d, i) => (op.del[i] ? null : d && withU({ ...d, a: "m", id: d.id }))));
        case "deleteMany":
          return c.deleteMany(op.ids);
        case "clear":
          return c.clear();
        case "view":
          return c.view(async (snap) => {
            const first = await snap.query({});
            const byOne = await snap.queryIds({ index: "one" });
            await c.put({ id: "a", a: "during a view", b: by });
            await kvs[by]!.sync();
            expect((await snap.query({})).docs).toEqual(first.docs);
            expect((await snap.queryIds({ index: "one" })).ids).toEqual(byOne.ids);
            expect(byOne.ids).toEqual(expected(first.docs, MODEL["one"], {}).map((h) => h.id));
          });
        case "upgrade": {
          const kv = await openKv(name);
          kvs.push(kv);
          upgraded.push(await openDocStore(kv, v2));
          return;
        }
      }
    });
    const settled = await Promise.allSettled(runs);
    for (const s of settled) if (s.status === "rejected") throw s.reason;

    const all = [...stores, ...upgraded];
    await Promise.all(all.map((s) => s.whenIdle()));
    for (const kv of kvs) await kv.sync();
    await Promise.all(all.map((s) => s.whenIdle()));
    const docs = (await all.at(-1)!.collection("docs").query({})).docs;
    for (const s of all) expect((await s.collection("docs").query({})).docs).toEqual(docs);
    await reader.reaches(new Map(docs.map((d) => [d.id, d])));

    const indexes = Object.entries((await storedCatalog(kvs[0]!)).collections["docs"]!.indexes);
    expect(Object.fromEntries(indexes.map(([n, i]) => [n, i.state.kind]))).toEqual(
      Object.fromEntries((upgraded.length > 0 ? Object.keys(MODEL) : ["one", "tags"]).map((n) => [n, "ready"])),
    );
    let entries = 0;
    for (const [n] of indexes) {
      const have = await keysUnder(kvs[0]!, await storedPrefix(kvs[0]!, "docs", n));
      expect([n, have]).toEqual([n, expected(docs, MODEL[n]!, {}).length]);
      entries += have;
      const c = (upgraded.at(-1) ?? stores[0]!).collection("docs");
      await checkQuery(c, docs, n, { index: n }, 3);
    }
    expect((await docstoreKeys(kvs[0]!)).length).toBe(1 + docs.length + entries);
  } finally {
    reader.stop();
    await Promise.all(kvs.map((kv) => kv.close().catch(() => undefined)));
  }
}

describe("concurrent writes from several handles", () => {
  it(
    "leave every index equal to its rows, every handle and a change-feed mirror on the same rows, and every snapshot on one state",
    async () => {
      await expect(
        fc.assert(fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: Number(env["DOCSTORE_CONCURRENT_OPS"] ?? 24) }), run), { numRuns: Number(env["DOCSTORE_CONCURRENT_RUNS"] ?? 40), ...replay }),
      ).resolves.toBeUndefined();
    },
    120_000,
  );
});

/**
 * The model test's indexes read top-level fields only. This history
 * indexes dot paths (README "Indexes": a dot path such as "meta.due"), where
 * an intermediate value may be missing, null, a scalar or an array, against
 * the same oracle.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { collection, defineSchema, openDocStore } from "../src/index.js";
import type { Scalar } from "../src/schema.js";
import { checkQuery, textArb } from "./docs.js";
import { docstoreKeys, freshName, openKv } from "./harness.js";
import { expected, stored, type ModelIndex } from "./oracle.js";
import { denseScalarArb } from "./order.js";

type Inner = { a?: Scalar | undefined; tags?: Scalar[] | undefined; t?: string | null | undefined; u?: Scalar | undefined; d?: { e?: Scalar | undefined } | undefined };
type Doc = { id: string; b?: Scalar | undefined; m?: Inner | Scalar | Scalar[] | undefined };

const schema = defineSchema({
  version: 1,
  collections: {
    docs: collection<Doc>()
      .index("ma", "m.a" as never)
      .index("deep", ["m.d.e", "b"] as never)
      .index("mtags", ["m.tags[]", "b"] as never)
      .unique("mu", "m.u" as never)
      .text("search", "m.a" as never, "m.t" as never)
      .index("cov", ["b", "m.a"] as never, { include: ["m", "b"] } as never),
  },
});

const MODEL: Record<string, ModelIndex> = {
  ma: { kind: "sorted", paths: ["m.a"] },
  deep: { kind: "sorted", paths: ["m.d.e", "b"] },
  mtags: { kind: "multi", paths: ["m.tags", "b"] },
  mu: { kind: "unique", paths: ["m.u"] },
  search: { kind: "text", paths: ["m.a"], text: "m.t" },
  cov: { kind: "sorted", paths: ["b", "m.a"], include: ["m", "b"] },
};

const innerArb: fc.Arbitrary<Inner> = fc.record(
  {
    a: denseScalarArb,
    tags: fc.array(denseScalarArb, { maxLength: 3 }),
    t: fc.option(textArb, { nil: null }),
    u: fc.constantFrom<Scalar>(null, 1, "x", "y", "z", true),
    d: fc.record({ e: denseScalarArb }, { requiredKeys: [] }),
  },
  { requiredKeys: [] },
);
const ids = fc.constantFrom("a", "b", "c", "d", "e", "\u0000", "😀");
const docArb: fc.Arbitrary<Doc> = fc.record(
  {
    id: ids,
    b: fc.option(denseScalarArb, { nil: undefined }),
    m: fc.oneof({ weight: 6, arbitrary: innerArb }, { weight: 1, arbitrary: fc.constantFrom<Scalar | Scalar[]>(null, 1, "s", []) }),
  },
  { requiredKeys: ["id"] },
);

type Op = { kind: "put"; doc: Doc } | { kind: "delete"; id: string } | { kind: "modify"; id: string; m: Doc["m"] };
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: docArb.map((doc) => ({ kind: "put" as const, doc })) },
  { weight: 1, arbitrary: ids.map((id) => ({ kind: "delete" as const, id })) },
  { weight: 2, arbitrary: fc.tuple(ids, docArb).map(([id, d]) => ({ kind: "modify" as const, id, m: d.m })) },
);

const sharesU = (docs: Iterable<Doc>) => {
  const seen = new Set<string>();
  for (const d of docs) {
    const m = d.m;
    if (typeof m !== "object" || m === null || Array.isArray(m) || m.u === undefined) continue;
    const k = JSON.stringify(m.u);
    if (seen.has(k)) return true;
    seen.add(k);
  }
  return false;
};

describe("indexes on dot paths", () => {
  it("agree with the oracle after every write, and leave only their entries in kv", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { maxLength: 25 }), async (ops) => {
        const kv = await openKv(freshName());
        try {
          const c = (await openDocStore(kv, schema)).collection("docs");
          let model = new Map<string, Doc>();
          for (const op of ops) {
            const next = new Map(model);
            if (op.kind === "put") next.set(op.doc.id, stored(op.doc));
            else if (op.kind === "delete") next.delete(op.id);
            else if (next.has(op.id)) next.set(op.id, stored({ ...next.get(op.id)!, m: op.m }));
            const write =
              op.kind === "put" ? c.put(op.doc) : op.kind === "delete" ? c.delete(op.id) : c.modify(op.id, (d) => ({ ...d, m: op.m }));
            if (sharesU(next.values())) {
              await expect(write).rejects.toMatchObject({ code: "unique" });
              continue;
            }
            await write;
            model = next;
          }
          const docs = [...model.values()];
          for (const index of Object.keys(MODEL)) await checkQuery(c as never, docs as never, index, { index }, 2, MODEL);
          const entries = Object.values(MODEL).reduce((n, ix) => n + expected(docs, ix, {}).length, 0);
          expect((await docstoreKeys(kv)).length).toBe(1 + docs.length + entries);
        } finally {
          await kv.close();
        }
      }),
      { numRuns: 200 },
    );
  }, 120_000);
});

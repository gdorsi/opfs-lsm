import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { collection, defineSchema, openDocStore } from "../src/index.js";
import type { Scalar } from "../src/schema.js";
import { freshName, gate, openKv } from "./harness.js";
import { expected, stored } from "./oracle.js";
import { denseScalarArb } from "./order.js";

/** `codes` are the row's own, so a unique index on them holds every row. */
type Row = { id: string; a?: Scalar | undefined; b?: Scalar | undefined; tags?: Scalar[] | undefined; codes?: string[] | undefined };

const v1 = defineSchema({ version: 1, collections: { rows: collection<Row>().index("byA", "a") } });
const v2 = defineSchema({
  version: 2,
  collections: {
    rows: collection<Row>().index("byA", "a").index("byB", ["b", "a"]).index("byTag", "tags[]").unique("byCode", "codes[]"),
  },
});

const ROWS = 1_200;
const id = (i: number) => `r${String(i).padStart(4, "0")}`;
const ids = (hits: readonly { id: string }[]) => hits.map((h) => h.id);

type Op =
  | { readonly kind: "put"; readonly row: Row }
  | { readonly kind: "delete"; readonly id: string }
  | { readonly kind: "modify"; readonly id: string; readonly b: Scalar };

const rowArb = (i: number): fc.Arbitrary<Row> =>
  fc.record(
    {
      id: fc.constant(id(i)),
      a: fc.option(denseScalarArb, { nil: undefined }),
      b: fc.option(denseScalarArb, { nil: undefined }),
      tags: fc.option(fc.array(denseScalarArb, { maxLength: 3 }), { nil: undefined }),
      codes: fc.option(fc.subarray([`${id(i)}:x`, `${id(i)}:y`, `${id(i)}:z`]), { nil: undefined }),
    },
    { requiredKeys: ["id"] },
  );
const anyId = fc.integer({ min: 0, max: ROWS + 50 });
const opArb: fc.Arbitrary<Op> = fc.oneof(
  anyId.chain(rowArb).map((row) => ({ kind: "put" as const, row })),
  anyId.map((i) => ({ kind: "delete" as const, id: id(i) })),
  fc.tuple(anyId, denseScalarArb).map(([i, b]) => ({ kind: "modify" as const, id: id(i), b })),
);

describe("two handles on one database", () => {
  it("fills the new indexes of one handle's schema, a unique multi one included, with every write the other handle made before, during and after the backfill", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.tuple(...Array.from({ length: ROWS }, (_, i) => rowArb(i))),
        fc.array(fc.array(opArb, { maxLength: 6 }), { minLength: 6, maxLength: 6 }),
        async (initial, batches) => {
          const name = freshName();
          const kvA = await openKv(name);
          const kvB = await openKv(name);
          try {
            const a = (await openDocStore(kvA, v1)).collection("rows");
            const model = new Map<string, Row>();
            const apply = async (ops: readonly Op[]) => {
              for (const op of ops) {
                switch (op.kind) {
                  case "put":
                    await a.put(op.row);
                    model.set(op.row.id, stored(op.row));
                    break;
                  case "delete":
                    await a.delete(op.id);
                    model.delete(op.id);
                    break;
                  case "modify": {
                    const next = await a.modify(op.id, (r) => ({ ...r, b: op.b }));
                    if (next) model.set(op.id, next);
                    break;
                  }
                }
              }
            };
            const rows: Row[] = initial;
            for (let i = 0; i < rows.length; i += 400) await a.putMany(rows.slice(i, i + 400));
            for (const r of rows) model.set(r.id, stored(r));

            const held = gate(kvB, "range", 0);
            const opening = openDocStore(held.db, v2);
            for (const [step, ops] of batches.entries()) {
              await Promise.race([held.arrived(step + 1), opening]);
              await apply(ops);
              held.release(1);
            }
            held.release();
            const b = (await opening).collection("rows");
            await apply(batches.flat().slice(0, 5));
            await kvB.sync();

            const docs = [...model.values()];
            expect((await b.queryIds({ index: "byB" })).ids).toEqual(ids(expected(docs, { kind: "sorted", on: ["b", "a"] }, {})));
            expect((await b.queryIds({ index: "byTag" })).ids).toEqual(ids(expected(docs, { kind: "multi", on: ["tags"] }, {})));
            expect((await b.queryIds({ index: "byCode" })).ids).toEqual(ids(expected(docs, { kind: "multi", on: ["codes"] }, {})));
          } finally {
            await kvA.close();
            await kvB.close();
          }
        },
      ),
      // Shrinking 1,200 rows outlasts the timeout; the reported seed replays the case.
      { numRuns: 15, endOnFailure: true },
    );
  }, 60_000);
});

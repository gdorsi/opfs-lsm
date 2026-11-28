import { isDeepStrictEqual } from "node:util";
import fc from "fast-check";
import { expect, it } from "vitest";
import { root } from "../src/builder.js";
import { openOn, tableOf } from "../src/database.js";
import { ConflictError, NotFoundError, query } from "../src/index.js";
import { freshName, openKv, until } from "./harness.js";
import { anyId, build, expected, patchArb, patched, rowArb, rowsArb, rowsDef, runs, specArb, type Patch, type Row } from "./model.js";

/** `via` picks the handle that writes: the one the subscribers read, or a second one on the same database. */
type Write = { readonly via: 0 | 1 } & (
  | { readonly kind: "upsert"; readonly rows: readonly Row[] }
  | { readonly kind: "insert"; readonly row: Row }
  | { readonly kind: "update"; readonly id: string; readonly patch: Patch }
  | { readonly kind: "delete"; readonly ids: readonly string[] }
  | { readonly kind: "clear" }
);

const via = fc.constantFrom<0 | 1>(0, 0, 1);
const writeArb: fc.Arbitrary<Write> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ via, kind: fc.constant("upsert" as const), rows: rowsArb(3) }) },
  { weight: 2, arbitrary: fc.record({ via, kind: fc.constant("insert" as const), row: rowArb() }) },
  { weight: 6, arbitrary: fc.record({ via, kind: fc.constant("update" as const), id: anyId, patch: patchArb }) },
  { weight: 4, arbitrary: fc.record({ via, kind: fc.constant("delete" as const), ids: fc.array(anyId, { minLength: 1, maxLength: 3 }) }) },
  { weight: 1, arbitrary: fc.record({ via, kind: fc.constant("clear" as const) }) },
);

it("a subscriber ends on the result of a fresh read after every write, and is never called twice with one result", async () => {
  const { numRuns, seed } = runs(60);
  const totals = { subscriptions: 0, writes: 0, changed: 0, calls: 0 };
  await fc.assert(
    fc.asyncProperty(
      rowsArb(16),
      fc.array(specArb, { minLength: 1, maxLength: 6 }),
      fc.array(fc.array(writeArb, { minLength: 1, maxLength: 3 }), { minLength: 1, maxLength: 10 }),
      async (initial, specs, bursts) => {
        const name = freshName();
        const dbs = [await openOn(await openKv(name), { version: 1, collections: { rows: rowsDef } }), await openOn(await openKv(name), { version: 1, collections: { rows: rowsDef } })] as const;
        try {
          const model = new Map(initial.map((row) => [row.id, row]));
          await dbs[0].collections.rows.insert(initial);

          const subs = specs.map((spec) => {
            const built = build(root, dbs[0].collections.rows, spec);
            const sub = { spec, built, values: [] as unknown[], repeats: 0, errors: [] as unknown[] };
            query(() => built).subscribe(
              (value) => {
                if (sub.values.length > 0 && isDeepStrictEqual(sub.values.at(-1), value)) sub.repeats++;
                sub.values.push(value);
              },
              (error) => sub.errors.push(error),
            );
            return sub;
          });
          totals.subscriptions += subs.length;
          const settled = async (after: string) => {
            for (const sub of subs) {
              const want = expected(sub.built, [...model.values()]);
              await until(
                () => sub.errors.length > 0 || (sub.values.length > 0 && isDeepStrictEqual(sub.values.at(-1), want)),
                () => `${JSON.stringify(sub.spec)} to show ${JSON.stringify(want)} after ${after}, last ${JSON.stringify(sub.values.at(-1))}`,
              );
              expect(sub.errors).toEqual([]);
            }
          };
          await settled("the first read");

          for (const burst of bursts) {
            const before = subs.map((sub) => expected(sub.built, [...model.values()]));
            for (const write of burst) {
              const { rows } = dbs[write.via].collections;
              switch (write.kind) {
                case "upsert":
                  await rows.upsert(write.rows);
                  for (const row of write.rows) model.set(row.id, row);
                  break;
                case "insert": {
                  const done = await rows.insert(write.row).catch((err: unknown) => err);
                  // Another handle may not have shown this one the row yet: the transaction still sees it.
                  if (model.has(write.row.id)) expect(done).toBeInstanceOf(ConflictError);
                  else model.set(write.row.id, write.row);
                  break;
                }
                case "update": {
                  const { patch } = write;
                  const done = await rows
                    .update(write.id, (draft) => {
                      Object.assign(draft, patched(draft, patch));
                    })
                    .catch((err: unknown) => err);
                  const had = model.get(write.id);
                  if (had) model.set(write.id, patched(had, patch));
                  else expect(done).toBeInstanceOf(NotFoundError);
                  break;
                }
                case "delete":
                  await rows.delete(write.ids);
                  for (const id of write.ids) model.delete(id);
                  break;
                case "clear":
                  await tableOf(rows).docs.clear();
                  model.clear();
              }
              totals.writes++;
            }
            await settled(JSON.stringify(burst));
            subs.forEach((sub, i) => {
              if (!isDeepStrictEqual(before[i], expected(sub.built, [...model.values()]))) totals.changed++;
            });
          }
          for (const sub of subs) {
            expect(sub.repeats, `${JSON.stringify(sub.spec)} was called twice with one result`).toBe(0);
            totals.calls += sub.values.length;
          }
        } finally {
          await Promise.all(dbs.map((db) => db.close()));
        }
      },
    ),
    { numRuns, seed },
  );
  console.log(`dirty rule property: seed ${seed}, ${numRuns} databases, ${JSON.stringify(totals)}`);
}, 30 * 60_000);

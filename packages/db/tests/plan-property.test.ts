import fc from "fast-check";
import { expect, it } from "vitest";
import { root } from "../src/builder.js";
import { openOn } from "../src/database.js";
import { query } from "../src/index.js";
import { openKv } from "./harness.js";
import { build, expected, rowsArb, rowsDef, runs, specArb } from "./model.js";

it("a run yields what a filter and a sort over every document yield", async () => {
  const { numRuns, seed } = runs(150);
  let queries = 0;
  await fc.assert(
    fc.asyncProperty(rowsArb(24), fc.array(specArb, { minLength: 1, maxLength: 12 }), async (docs, specs) => {
      const db = await openOn(await openKv(), { version: 1, collections: { rows: rowsDef } });
      try {
        const { rows } = db.collections;
        await rows.insert(docs);
        for (const spec of specs) {
          const built = build(root, rows, spec);
          const live = query(() => built);
          expect(await live.run(), `${JSON.stringify(spec)} planned as ${JSON.stringify(live.explain())}`).toEqual(expected(built, docs));
          queries++;
        }
      } finally {
        await db.close();
      }
    }),
    { numRuns, seed },
  );
  console.log(`planner property: seed ${seed}, ${numRuns} databases, ${queries} queries`);
}, 30 * 60_000);

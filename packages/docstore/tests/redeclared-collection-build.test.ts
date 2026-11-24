/**
 * A collection dropped and declared again keeps its name and gets its index
 * ids again, under a new collection id. A build that outlived the drop names
 * its index by collection id, so it must leave the new index alone.
 */
import { describe, expect, it } from "vitest";
import { collection, defineSchema, openDocStore } from "../src/index.js";
import { freshName, gate, openKv, wrap } from "./harness.js";

type Row = { id: string; a: number };

const plain = collection<Row>();
const byA = collection<Row>().index("byA", "a");
const rows = (prefix: string, n: number, a?: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: prefix + String(i).padStart(3, "0"), a: a ?? i }));

describe("a build that outlives a drop of its collection", () => {
  it("leaves alone the index that the collection declared again gets under the same name and id", async () => {
    const name = freshName();
    const kv = await openKv(name);
    const first = await openDocStore(kv, defineSchema({ version: 1, collections: { rows: plain, other: plain } }));
    // More rows than one backfill step takes, so the build commits twice.
    await first.collection("rows").putMany(rows("r", 600));
    await first.collection("other").putMany(rows("o", 5, 1));
    const tab = await openKv(name);
    // Holds the new build's scan, so the old build runs first.
    const held = gate(tab, "range", 0);
    const v5 = defineSchema({ version: 5, collections: { rows: byA, other: plain } });
    let again: ReturnType<typeof openDocStore<typeof v5>> | undefined;
    let steps = 0;
    const db = wrap(kv, {
      update: async (keys, body) => {
        // A backfill step reads its rows besides the catalog.
        if (keys.length > 1 && ++steps === 2) {
          await (await openDocStore(tab, defineSchema({ version: 3, collections: { other: plain }, drop: ["rows"] }))).whenIdle();
          const declared = await openDocStore(tab, defineSchema({ version: 4, collections: { rows: plain, other: plain } }));
          await declared.collection("rows").putMany(rows("n", 10, 1));
          again = openDocStore(held.db, v5);
          await held.arrived(1);
          await kv.sync();
        }
        return kv.update(keys, body);
      },
    });
    await (await openDocStore(db, defineSchema({ version: 2, collections: { rows: byA, other: plain } }))).whenIdle();
    expect(steps).toBeGreaterThanOrEqual(2);
    held.release();
    const store = await again!;
    await store.whenIdle();
    expect((await store.collection("rows").queryIds({ index: "byA" })).ids).toEqual(rows("n", 10).map((r) => r.id));
    await tab.close();
    await kv.close();
  });
});

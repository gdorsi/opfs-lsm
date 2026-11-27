/** README "Indexes": `by` takes a list of 1 to 8 fields. */
import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "@opfs-lsm/kv";
import { collection, defineSchema, openDocStore } from "../src/index.js";
import { codeOf, freshName, openKv } from "./harness.js";

type Row = { id: string; f1: number; f2: number; f3: number; f4: number; f5: number; f6: number; f7: number; f8: number; f9: number };

const open: Db[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((kv) => kv.close()));
});

describe("an index over the most fields by takes", () => {
  it("takes 8 fields and orders by all of them, and refuses 9", async () => {
    const kv = await openKv(freshName());
    open.push(kv);
    const by = ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8"] as const;
    const schema = defineSchema({ version: 1, collections: { rows: collection<Row>().index("all", by) } });
    const rows = (await openDocStore(kv, schema)).collection("rows");
    const row = (id: string, last: number): Row => ({ id, f1: 1, f2: 1, f3: 1, f4: 1, f5: 1, f6: 1, f7: 1, f8: last, f9: 0 });
    await rows.putMany([row("x", 3), row("y", 2), row("z", 1)]);
    expect((await rows.queryIds({ index: "all", eq: [1, 1, 1, 1, 1, 1, 1], gte: 2 })).ids).toEqual(["y", "x"]);

    const nine = defineSchema({ version: 1, collections: { rows: collection<Row>().index("all", [...by, "f9"] as never) } });
    const other = await openKv(freshName());
    open.push(other);
    expect(await codeOf(openDocStore(other, nine))).toBe("schema");
  });
});

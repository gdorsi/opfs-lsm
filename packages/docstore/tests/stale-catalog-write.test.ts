/**
 * A write is planned against the handle's catalog, which can lag another
 * tab's schema change. An error the plan throws holds only once the handle
 * has read every acked write (README "Schema versions": a newer schema's
 * removed index is gone for every writer).
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "@opfs-lsm/kv";
import { collection, defineSchema, openDocStore } from "../src/index.js";
import { freshName, openKv, openKvWithoutBus } from "./harness.js";

type Row = { id: string; a?: number | { nested: boolean }; b?: number };

const open: Db[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((kv) => kv.close()));
});

describe("a handle whose catalog lags another tab's schema change", () => {
  it("stores a document that only an index the newer schema removed could not hold", async () => {
    const v1 = defineSchema({ version: 1, collections: { rows: collection<Row>().index("byA", "a" as never) } });
    const v2 = defineSchema({ version: 2, collections: { rows: collection<Row>().index("byB", "b") } });
    const name = freshName();
    const lagging = await openKvWithoutBus(name);
    const other = await openKv(name);
    open.push(lagging, other);
    const rows = (await openDocStore(lagging, v1)).collection("rows");
    await rows.put({ id: "r0", a: 1 });

    await openDocStore(other, v2);
    // byA would refuse an object; v2 removed byA, so the write must land.
    await rows.put({ id: "r1", a: { nested: true }, b: 2 });

    expect(await rows.get("r1")).toEqual({ id: "r1", a: { nested: true }, b: 2 });
    const next = (await openDocStore(other, v2)).collection("rows");
    await other.sync();
    expect((await next.queryIds({ index: "byB" })).ids).toEqual(["r1"]);
  });
});

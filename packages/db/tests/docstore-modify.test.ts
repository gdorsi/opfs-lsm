import { collection, defineSchema, openDocStore } from "@opfs-lsm/docstore";
import { expect, it } from "vitest";
import { openKv } from "./harness.js";

type Row = { id: string; n: number };
const schema = defineSchema({ version: 1, collections: { rows: collection<Row>().index("byN", "n") } });

// `update` throws ValidationError and NotFoundError from inside docstore's `modify`, so it needs both halves of this.
it("docstore modify hands a throw of fn to the caller as it is, and stores nothing", async () => {
  const kv = await openKv();
  const rows = (await openDocStore(kv, schema)).collection("rows");
  await rows.put({ id: "a", n: 1 });
  const thrown = new Error("from fn");
  await expect(
    rows.modify("a", (row) => {
      (row as { n: number }).n = 2;
      throw thrown;
    }),
  ).rejects.toBe(thrown);
  expect(await rows.get("a")).toEqual({ id: "a", n: 1 });
  expect(await rows.queryIds({ index: "byN", eq: [2] })).toEqual({ ids: [] });
  await kv.close();
});

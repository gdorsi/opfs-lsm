/**
 * A count index whose first field is an array field takes one
 * value for that field in eq (README "Count"), but a list in a later slot is
 * a valid query (the types allow it: CountWhere), whose groups share no
 * document. No test read such a query.
 */
import { describe, expect, it } from "vitest";
import { collection, defineSchema, openDocStore } from "../src/index.js";
import { codeOf, freshName, openKv } from "./harness.js";
import { expected } from "./oracle.js";

type Row = { id: string; tags: string[]; b: string };
const schema = defineSchema({ version: 1, collections: { rows: collection<Row>().count("perTagB", ["tags[]", "b"]) } });
const MODEL = { kind: "count", on: ["tags", "b"], multi: true } as const;

describe("a count index on an array field and another field", () => {
  it("adds the groups of a list in the slot after the array field, and refuses one in the array field's slot", async () => {
    const kv = await openKv(freshName());
    try {
      const c = (await openDocStore(kv, schema)).collection("rows");
      const docs: Row[] = Array.from({ length: 60 }, (_, i) => ({ id: `r${i}`, tags: [`t${i % 3}`, `t${i % 5}`], b: `b${i % 4}` }));
      await c.putMany(docs);
      for (const q of [
        { eq: ["t1", ["b0", "b2"]] },
        { eq: ["t1", ["b0", "b0", "b3", "absent"]] },
        { eq: ["t4", []] },
        { eq: ["t2", ["b1"]] },
        { eq: ["t0"], gte: "b1" },
      ]) {
        expect({ q, n: await c.count({ index: "perTagB", ...q } as never) }).toEqual({ q, n: expected(docs, MODEL, q as never).length });
      }
      expect(await c.count({ index: "perTagB", eq: ["t1", ["b0", "b2"]], limit: 3 } as never)).toBe(3);
      expect(await codeOf(c.count({ index: "perTagB", eq: [["t1", "t2"], "b0"] } as never))).toBe("query");
    } finally {
      await kv.close();
    }
  });
});

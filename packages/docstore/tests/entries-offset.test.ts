/**
 * Audit gap: `offset` passes over results (README "Offsets") for every read,
 * but the model test and the other suites check it on query, queryIds and
 * count only. queryEntries decodes values per entry, so an entry the offset
 * passes must neither appear nor take a slot of the page.
 */
import { describe, expect, it } from "vitest";
import { openDocStore } from "../src/index.js";
import { asQuery, schema, type Doc } from "./docs.js";
import { freshName, openKv } from "./harness.js";

const docs: Doc[] = Array.from({ length: 9 }, (_, i) => ({
  id: `d${i}`,
  a: i % 3,
  b: i % 2,
  t: `word${i}`,
  tags: [`x${i % 2}`, `y${i % 3}`],
  u: `u${i}`,
}));

describe("queryEntries with offset", () => {
  it("returns the entries after offset, with their values and fields, on one range and on a merge", async () => {
    const kv = await openKv(freshName());
    try {
      const c = (await openDocStore(kv, schema)).collection("docs");
      await c.putMany(docs);
      for (const q of [
        { index: "covered" },
        { index: "covered", reverse: true },
        { index: "covered", eq: [[0, 1]] },
        { index: "tags", eq: [["x0", "y1", "x1"]] },
        { index: "uniq" },
        { index: "search", match: "word" },
        {},
      ]) {
        const all = (await c.queryEntries(asQuery(q))).entries;
        expect(all.length).toBeGreaterThan(3);
        for (const offset of [1, 2, all.length - 1, all.length]) {
          expect({ q, offset, entries: (await c.queryEntries(asQuery({ ...q, offset }))).entries }).toEqual({ q, offset, entries: all.slice(offset) });
          for (const limit of [1, 2]) {
            const page = await c.queryEntries(asQuery({ ...q, offset, limit }));
            expect({ q, offset, limit, entries: page.entries }).toEqual({ q, offset, limit, entries: all.slice(offset, offset + limit) });
            expect(page.next !== undefined).toBe(offset + limit < all.length);
          }
        }
      }
    } finally {
      await kv.close();
    }
  });
});

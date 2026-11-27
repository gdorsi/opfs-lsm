/**
 * A text index matches case-insensitively (README "Text"). `toLowerCase`
 * maps a Greek capital sigma to the final form at the end of a word and to
 * the plain one inside, so the match must treat the two as one letter.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "@opfs-lsm/kv";
import { collection, defineSchema, openDocStore } from "../src/index.js";
import { freshName, openKv } from "./harness.js";

type Book = { id: string; title: string; at: number };

const open: Db[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((kv) => kv.close()));
});

async function books() {
  const kv = await openKv(freshName());
  open.push(kv);
  const schema = defineSchema({ version: 1, collections: { books: collection<Book>().text("search", "at", "title") } });
  const c = (await openDocStore(kv, schema)).collection("books");
  await c.putMany([
    { id: "odyssey", title: "Οδυσσεύς", at: 1 },
    { id: "caps", title: "ΟΔΥΣ", at: 2 },
  ]);
  return c;
}

describe("a text match on Greek words", () => {
  it("finds a title whatever the case of the typed sigma, as it does for Latin letters", async () => {
    const c = await books();
    const found = async (match: string) => (await c.queryIds({ index: "search", match })).ids;
    // Each query is a case-insensitive prefix of both titles, as "MILK" is of "Milkshake".
    expect({ lower: await found("οδυσ"), upper: await found("ΟΔΥΣ") }).toEqual({
      lower: ["odyssey", "caps"],
      upper: ["odyssey", "caps"],
    });
  });
});

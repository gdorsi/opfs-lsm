/**
 * What docstore exports so that a layer above applies its checks itself: the
 * id check, the word split, the folding of text and the two limits. Each must
 * agree with what a write and a query do.
 */
import type { Db } from "@opfs-lsm/kv";
import { afterEach, describe, expect, it } from "vitest";
import { collection, defineSchema, foldText, isDocId, MAX_ID_BYTES, MAX_RANGES, openDocStore, wordsOf } from "../src/index.js";
import { codeOf, freshName, openKv } from "./harness.js";

type Doc = { id: string; text: string; n: number };

const open: Db[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((kv) => kv.close()));
});

async function docs() {
  const kv = await openKv(freshName());
  open.push(kv);
  const schema = defineSchema({ version: 1, collections: { docs: collection<Doc>().text("search", "n", "text").index("byN", ["n", "text"]) } });
  return (await openDocStore(kv, schema)).collection("docs");
}

describe("isDocId", () => {
  const bytes = (n: number, unit: string) => unit.repeat(Math.floor(n / new TextEncoder().encode(unit).length));
  const ids: [string, unknown, boolean][] = [
    ["a letter", "a", true],
    ["a number-like string", "0", true],
    ["a space", " ", true],
    ["an id of the most bytes", "x".repeat(MAX_ID_BYTES), true],
    ["an id one byte over", "x".repeat(MAX_ID_BYTES + 1), false],
    ["three-byte characters up to the most", bytes(MAX_ID_BYTES, "€"), true],
    ["three-byte characters one over", bytes(MAX_ID_BYTES, "€") + "€", false],
    ["four-byte characters up to the most", bytes(MAX_ID_BYTES, "😀"), true],
    ["four-byte characters one over", bytes(MAX_ID_BYTES, "😀") + "😀", false],
    ["an empty string", "", false],
    ["a lone high surrogate", "a\uD800", false],
    ["a lone low surrogate", "\uDC00b", false],
    ["a pair of surrogates", "😀", true],
    ["a number", 5, false],
    ["null", null, false],
    ["undefined", undefined, false],
    ["an object", { id: "a" }, false],
  ];

  it("takes ids of at most 1024 UTF-8 bytes", () => {
    expect(MAX_ID_BYTES).toBe(1024);
    expect(isDocId("x".repeat(1024))).toBe(true);
    expect(isDocId("x".repeat(1025))).toBe(false);
  });

  it.each(ids)("is %s", (_, id, ok) => {
    expect(isDocId(id)).toBe(ok);
  });

  it("holds for the ids a write takes, and for no other: MAX_ID_BYTES is the longest", async () => {
    const c = await docs();
    for (const [, id, ok] of ids) {
      const write = c.put({ id, text: "", n: 0 } as Doc);
      if (ok) await write;
      else expect(await codeOf(write)).toBe("document");
    }
  });
});

describe("foldText", () => {
  it("is NFC, lowercase, and one sigma", () => {
    expect(foldText("Fix LOGIN")).toBe("fix login");
    expect(foldText("é")).toBe("é");
    expect(foldText("ΟΔΟΣ")).toBe("οδοσ");
    expect(foldText("οδος")).toBe("οδοσ");
    expect(foldText("İ")).toBe("i̇");
  });
});

describe("wordsOf", () => {
  it("cuts at every character that is not a letter, a combining mark or a digit, in the folded form", () => {
    expect(wordsOf("Fix: the login-page, 50% of café!")).toEqual(["fix", "the", "login", "page", "50", "of", "café"]);
    expect(wordsOf("école x_y\t1.5")).toEqual(["école", "x", "y", "1", "5"]);
    // A combining mark with no precomposed letter stays inside its word.
    expect(wordsOf("x́y z")).toEqual(["x́y", "z"]);
    expect(wordsOf("ΟΔΟΣ οδος")).toEqual(["οδοσ", "οδοσ"]);
    expect(wordsOf("  ,. ")).toEqual([]);
    expect(wordsOf("")).toEqual([]);
  });

  it("are the words a text index finds a document by", async () => {
    const c = await docs();
    const texts = ["Fix: the login-page", "café au lait, 50% off", "ΟΔΟΣ", "x_y z", "école"];
    await c.putMany(texts.map((text, i) => ({ id: `d${i}`, text, n: i })));
    for (const [i, text] of texts.entries()) {
      for (const word of wordsOf(text)) expect((await c.queryIds({ index: "search", match: word })).ids).toContain(`d${i}`);
    }
    expect((await c.queryIds({ index: "search", match: "login-page" })).ids).toEqual(["d0"]);
    expect((await c.queryIds({ index: "search", match: "%" })).ids).toEqual(texts.map((_, i) => `d${i}`));
  });
});

describe("MAX_RANGES", () => {
  it("is the most combinations of listed values one query reads", async () => {
    const c = await docs();
    const many = (n: number) => Array.from({ length: n }, (_, i) => i);
    const side = Math.sqrt(MAX_RANGES);
    expect(await c.count({ index: "byN", eq: [many(side), many(side).map(String)] })).toBe(0);
    expect(await codeOf(c.count({ index: "byN", eq: [many(side + 1), many(side).map(String)] }))).toBe("query");
    expect(await c.count({ index: "byN", eq: [many(MAX_RANGES)] })).toBe(0);
    expect(await codeOf(c.count({ index: "byN", eq: [many(MAX_RANGES + 1)] }))).toBe("query");
  });
});

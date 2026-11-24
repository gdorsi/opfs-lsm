/**
 * A string bound the index orders differently from TanStack must
 * not narrow an index read. The index orders strings by code point, TanStack
 * by UTF-16 unit, so `lt(s, "Ａ")` matches an astral string in TanStack
 * (its lead surrogate U+D83D sorts first) while the index puts it after U+FF21.
 */
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { collection, defineSchema, openDocStore } from "@opfs-lsm/docstore";
import { openHarnessDb } from "@opfs-lsm/kv/testing";
import { and, createCollection, createLiveQueryCollection, eq, gt, lt } from "@tanstack/db";
import { docstoreCollectionOptions } from "../src/index.ts";

type Doc = { id: string; g: number; s: string };
const schema = defineSchema({ version: 1, collections: { docs: collection<Doc>().index("byGS", ["g", "s"]) } });

const DOCS: Doc[] = [
  { id: "astral", g: 0, s: "\u{1F600}" },
  { id: "bmp", g: 0, s: "Ｂ" },
  { id: "ascii", g: 0, s: "a" },
  { id: "other", g: 1, s: "a" },
];

test("an on-demand query bounded by a string past U+D800 finds every row TanStack's order matches", async () => {
  const kv = await openHarnessDb({ name: `tsdb${randomUUID().replaceAll("-", "").slice(0, 20)}`, forceMemory: true });
  const store = await openDocStore(kv, schema);
  await store.collection("docs").putMany(DOCS);
  const c = createCollection(docstoreCollectionOptions({ collection: store.collection("docs"), syncMode: "on-demand" }));
  const below = createLiveQueryCollection((q) => q.from({ d: c }).where(({ d }) => and(eq(d.g, 0), lt(d.s, "Ａ"))));
  const above = createLiveQueryCollection((q) => q.from({ d: c }).where(({ d }) => and(eq(d.g, 0), gt(d.s, "Ａ"))));
  try {
    await below.preload();
    await above.preload();
    const ids = (rows: readonly Doc[]) => rows.map((r) => r.id).sort();
    // UTF-16 order: "a" < "😀" < "Ａ" < "Ｂ".
    assert.deepEqual(ids(below.toArray), ["ascii", "astral"]);
    assert.deepEqual(ids(above.toArray), ["bmp"]);
  } finally {
    await below.cleanup();
    await above.cleanup();
    await c.cleanup();
    await kv.close();
  }
});

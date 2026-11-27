/**
 * TanStack DB rc.1.5 folds an offset into the limit and follows a locale-ordered
 * load with a full-source one, so a live query cannot see these loads go wrong.
 * They call `loadSubset` as TanStack may, and check the rows it syncs.
 */
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { collection, defineSchema, openDocStore } from "@opfs-lsm/docstore";
import { openHarnessDb } from "@opfs-lsm/kv/testing";
import { IR, type LoadSubsetOptions } from "@tanstack/db";
import { docstoreCollectionOptions } from "../src/index.ts";

type Doc = { id: string; n: number; s: string };

const schema = defineSchema({
  version: 1,
  collections: { docs: collection<Doc>().index("byS", "s").index("byN", "n") },
});

/** The ids one `loadSubset` syncs into the collection. */
async function synced(docs: Doc[], options: LoadSubsetOptions): Promise<string[]> {
  const kv = await openHarnessDb({ name: `t${randomUUID().replaceAll("-", "").slice(0, 16)}`, forceMemory: true });
  const store = await openDocStore(kv, schema);
  await store.collection("docs").putMany(docs);
  const held = new Set<string>();
  const handle = docstoreCollectionOptions({ collection: store.collection("docs"), syncMode: "on-demand" }).sync.sync({
    collection: undefined as never,
    begin: () => {},
    write: (m: { type: string; value?: Doc; key?: string }) => {
      if (m.type === "delete") held.delete(m.key!);
      else held.add(m.value!.id);
    },
    commit: () => {},
    markReady: () => {},
    truncate: () => {},
    fail: () => {},
    invalidateLoadedSubsets: () => {},
    metadata: undefined as never,
  } as never) as { cleanup(): void; loadSubset(o: LoadSubsetOptions): Promise<void> };
  try {
    await handle.loadSubset(options);
    return [...held].sort();
  } finally {
    handle.cleanup();
    await kv.close();
  }
}

const by = (path: string, stringSort: "lexical" | "locale"): IR.OrderBy => [
  { expression: new IR.PropRef([path]), compareOptions: { direction: "asc", nulls: "first", stringSort } },
];

test("a load ordered by locale syncs the row that sorts first by locale, though index order puts another first", async () => {
  const docs: Doc[] = [
    { id: "1", n: 0, s: "a" },
    { id: "2", n: 0, s: "B" },
    { id: "3", n: 0, s: "c" },
  ];
  assert.equal(["a", "B", "c"].sort((x, y) => x.localeCompare(y))[0], "a");
  const ids = await synced(docs, { orderBy: by("s", "locale"), limit: 1 });
  assert.ok(ids.includes("1"), `synced ${JSON.stringify(ids)}`);
});

test("a load with an offset syncs the rows past the offset", async () => {
  const docs: Doc[] = Array.from({ length: 8 }, (_, i) => ({ id: `d${i}`, n: i, s: "" }));
  const ids = await synced(docs, { orderBy: by("n", "lexical"), limit: 2, offset: 4 });
  assert.ok(ids.includes("d4") && ids.includes("d5"), `synced ${JSON.stringify(ids)}`);
});

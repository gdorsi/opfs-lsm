import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { collection, defineSchema, openDocStore } from "@opfs-lsm/docstore";
import { ClosedError } from "@opfs-lsm/kv";
import { openHarnessDb } from "@opfs-lsm/kv/testing";
import {
  createCollection,
  createLiveQueryCollection,
  eq,
  localOnlyCollectionOptions,
  type Collection,
} from "@tanstack/db";
import { docstoreCollectionOptions } from "../src/index.ts";

type Doc = { id: string; k?: boolean; n?: unknown; s?: unknown; t?: string | null };

const schema = defineSchema({
  version: 1,
  collections: {
    sorted: collection<Doc>().index("byN", "n").index("byS", "s"),
    texted: collection<Doc>().text("search", ["k", "n"], "t"),
    todos: collection<{ id: string; title: string; done: boolean }>(),
  },
});

type Name = "sorted" | "texted";

const strip = (rows: readonly object[]) => rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith("$"))));
const byId = (rows: readonly object[]) => strip(rows).sort((a, b) => String(a["id"]).localeCompare(String(b["id"])));

/** The rows a live query shows over an on-demand docstore collection, and over every document held in memory. */
async function both(
  name: Name,
  docs: readonly Doc[],
  build: (source: Collection<Doc, string, any>) => { preload(): Promise<void>; toArray: object[]; cleanup(): Promise<void> },
  ordered = false,
) {
  const kv = await openHarnessDb({ name: `promises${randomUUID().slice(0, 8)}`, forceMemory: true, maxWalBytes: 1 << 30 });
  try {
    const store = await openDocStore(kv, schema);
    await store.collection(name).putMany(docs as Doc[]);
    const target = createCollection(docstoreCollectionOptions({ collection: store.collection(name), syncMode: "on-demand" }));
    const reference = createCollection(localOnlyCollectionOptions({ getKey: (d: Doc) => d.id, initialData: [...docs] }));
    const got = build(target);
    const want = build(reference);
    await Promise.all([got.preload(), want.preload()]);
    const view = ordered ? strip : byId;
    const result = { got: view(got.toArray), want: view(want.toArray) };
    await Promise.all([got.cleanup(), want.cleanup(), target.cleanup(), reference.cleanup()]);
    return result;
  } finally {
    await kv.close();
  }
}

test("a document stores null for a text index's text field, and a load through the index finds it", async () => {
  const docs = [{ id: "nullText", k: true, n: 1, t: null }];
  const { got, want } = await both("texted", docs, (c) => createLiveQueryCollection((q) => q.from({ d: c }).where(({ d }) => eq(d.k, true))));
  assert.deepEqual(want.map((r) => r["id"]), ["nullText"]);
  assert.deepEqual(got, want);
});

test("closing kv stops every collection on it, eager and on-demand, and later writes reject with ClosedError", async () => {
  const kv = await openHarnessDb({ name: `promises${randomUUID().slice(0, 8)}`, forceMemory: true, maxWalBytes: 1 << 30 });
  const store = await openDocStore(kv, schema);
  const eagerC = createCollection(docstoreCollectionOptions({ collection: store.collection("sorted") }));
  const lazyC = createCollection(docstoreCollectionOptions({ collection: store.collection("texted"), syncMode: "on-demand" }));
  await eagerC.preload();
  lazyC.startSyncImmediate();
  await kv.close();
  for (let i = 0; i < 100 && !(eagerC.health.error && lazyC.health.error); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(eagerC.health.error?.name, "ClosedError", "the eager collection fails with ClosedError");
  assert.equal(lazyC.health.error?.name, "ClosedError", "the on-demand collection fails with ClosedError");
  await assert.rejects(eagerC.insert({ id: "late", n: 1 }).when("settled"), ClosedError);
  await assert.rejects(lazyC.insert({ id: "late", k: true, n: 1, t: "x" }).when("settled"), ClosedError);
  await Promise.all([eagerC.cleanup(), lazyC.cleanup()]);
});

test("an update stores the whole row as this tab holds it, so the last of two tabs' updates wins", async () => {
  const name = `promises${randomUUID().slice(0, 8)}`;
  const g = globalThis as { BroadcastChannel?: unknown };
  const kvA = await openHarnessDb({ name, forceMemory: true, maxWalBytes: 1 << 30 });
  const real = g.BroadcastChannel;
  g.BroadcastChannel = undefined;
  const kvB = await openHarnessDb({ name, forceMemory: true, maxWalBytes: 1 << 30 }).finally(() => {
    g.BroadcastChannel = real;
  });
  try {
    const [a, b] = await Promise.all(
      [kvA, kvB].map(async (kv) => createCollection(docstoreCollectionOptions({ collection: (await openDocStore(kv, schema)).collection("todos") }))),
    );
    await a!.preload();
    await a!.insert({ id: "1", title: "milk", done: false }).when("settled");
    await kvB.sync();
    await b!.preload();
    await a!.update("1", (d) => {
      d.title = "oat milk";
    }).when("settled");
    assert.equal(b!.get("1")?.title, "milk", "b has not seen a's update");
    await b!.update("1", (d) => {
      d.done = true;
    }).when("settled");
    await kvA.sync();
    const stored = await (await openDocStore(kvA, schema)).collection("todos").get("1");
    assert.deepEqual(stored, { id: "1", title: "milk", done: true }, "b's whole row replaced a's title");
    await Promise.all([a!.cleanup(), b!.cleanup()]);
  } finally {
    await kvA.close();
    await kvB.close();
  }
});

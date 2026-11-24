import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { openHarnessDb } from "@opfs-lsm/kv/testing";
import * as Y from "yjs";
import { KvPersistence } from "../src/index.ts";

function dbName(): string {
  return `yjs${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("doc.destroy() destroys the persistence: a merge waiting for the doc to go quiet never runs", async (t) => {
  const db = await openHarnessDb({ name: dbName(), forceMemory: true });
  t.after(() => db.close());
  const doc = new Y.Doc();
  const p = new KvPersistence(db, "doc", doc, 10);
  p.trimDelayMs = 20;
  await p.whenSynced;
  for (let i = 0; i < 12; i++) doc.getText("t").insert(i, "x");
  doc.destroy();
  await sleep(60);
  await p.destroy();

  const again = new KvPersistence(db, "doc", new Y.Doc(), 1000);
  await again.whenSynced;
  assert.equal(again.loadedUpdates, 12);
  assert.equal(again.doc.getText("t").toString(), "x".repeat(12));
  await again.destroy();
});

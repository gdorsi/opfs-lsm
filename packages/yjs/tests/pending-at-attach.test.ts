/**
 * Content a doc already holds when the persistence is constructed is stored
 * (README). That includes content still pending: an update that arrived
 * before the one it builds on, as a sync provider can deliver.
 */
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

test("a pending update the doc held before the persistence was attached is stored", async (t) => {
  const db = await openHarnessDb({ name: dbName(), forceMemory: true });
  t.after(() => db.close());

  const source = new Y.Doc();
  const updates: Uint8Array[] = [];
  source.on("update", (u: Uint8Array) => updates.push(u));
  source.getText("t").insert(0, "a");
  source.getText("t").insert(1, "b");
  const [first, second] = updates as [Uint8Array, Uint8Array];

  // The second update arrives first: Yjs holds it as pending.
  const doc = new Y.Doc();
  Y.applyUpdate(doc, second);
  assert.equal(doc.getText("t").toString(), "");
  assert.ok(doc.store.pendingStructs);

  const p = new KvPersistence(db, "d", doc);
  await p.whenSynced;
  await p.destroy();

  const again = new Y.Doc();
  const q = new KvPersistence(db, "d", again);
  await q.whenSynced;
  Y.applyUpdate(again, first);
  assert.equal(again.getText("t").toString(), "ab");
  await q.destroy();
});

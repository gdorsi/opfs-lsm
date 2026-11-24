import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Db } from "@opfs-lsm/kv";
import { openHarnessDb } from "@opfs-lsm/kv/testing";
import * as Y from "yjs";
import { KvPersistence } from "../src/index.ts";

function dbName(): string {
  return `yjs${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

async function reopen(db: Db, name: string) {
  const doc = new Y.Doc();
  const p = new KvPersistence(db, name, doc);
  await p.whenSynced;
  return { doc, p };
}

test("a second persistence on the same doc stores what the first one loads, and neither writes its own load back", async (t) => {
  const main = await openHarnessDb({ name: dbName(), forceMemory: true });
  const backup = await openHarnessDb({ name: dbName(), forceMemory: true });
  t.after(() => Promise.all([main.close(), backup.close()]));
  const seed = await reopen(main, "doc");
  seed.doc.getText("t").insert(0, "from main");
  await seed.p.destroy();

  const doc = new Y.Doc();
  const fromBackup = new KvPersistence(backup, "doc", doc);
  const fromMain = new KvPersistence(main, "doc", doc);
  await Promise.all([fromBackup.whenSynced, fromMain.whenSynced]);
  doc.getText("t").insert(9, ", edited");
  await Promise.all([fromBackup.destroy(), fromMain.destroy()]);

  const inBackup = await reopen(backup, "doc");
  assert.equal(inBackup.doc.getText("t").toString(), "from main, edited");
  assert.equal(inBackup.p.loadedUpdates, 2, "the main load and the edit");
  const inMain = await reopen(main, "doc");
  assert.equal(inMain.doc.getText("t").toString(), "from main, edited");
  assert.equal(inMain.p.loadedUpdates, 2, "the seed and the edit");
  assert.deepEqual(Y.encodeStateVector(inMain.doc), Y.encodeStateVector(doc));
  assert.deepEqual(Y.encodeStateVector(inBackup.doc), Y.encodeStateVector(doc));
});

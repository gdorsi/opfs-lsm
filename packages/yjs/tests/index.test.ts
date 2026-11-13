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

async function reopen(db: Db, name: string, trim?: number) {
  const doc = new Y.Doc();
  const p = new KvPersistence(db, name, doc, trim);
  await p.whenSynced;
  return { doc, p };
}

test("updates round-trip and documents stay apart", async () => {
  const db = await openHarnessDb({ name: dbName(), forceMemory: true });
  const a = await reopen(db, "a");
  const ab = await reopen(db, "a/b");
  a.doc.getText("t").insert(0, "hello");
  a.doc.getText("t").insert(5, " world");
  ab.doc.getText("t").insert(0, "other");
  await a.p.destroy();
  await ab.p.destroy();

  const again = await reopen(db, "a");
  assert.equal(again.doc.getText("t").toString(), "hello world");
  assert.equal(again.p.loadedUpdates, 2);
  const other = await reopen(db, "a/b");
  assert.equal(other.doc.getText("t").toString(), "other");
  await db.close();
});

test("a load at the trim size merges updates into one", async () => {
  const db = await openHarnessDb({ name: dbName(), forceMemory: true });
  const first = await reopen(db, "doc", 10);
  for (let i = 0; i < 12; i++) first.doc.getText("t").insert(i, "x");
  await first.p.destroy();

  const second = await reopen(db, "doc", 10);
  assert.equal(second.p.loadedUpdates, 12);
  await second.p.flush();
  const third = await reopen(db, "doc", 10);
  assert.equal(third.p.loadedUpdates, 1);
  assert.equal(third.doc.getText("t").toString(), "x".repeat(12));
  await db.close();
});

test("clearData empties one document and leaves the others on the same db", async () => {
  const db = await openHarnessDb({ name: dbName(), forceMemory: true });
  const a = await reopen(db, "a");
  const ab = await reopen(db, "a/b");
  a.doc.getText("t").insert(0, "gone");
  ab.doc.getText("t").insert(0, "kept");
  await a.p.flush();
  await ab.p.flush();
  a.doc.getText("t").insert(4, " unflushed");

  await a.p.clearData();
  a.doc.getText("t").insert(0, "after ");
  await a.p.flush();
  await ab.p.destroy();

  const clearedAgain = await reopen(db, "a");
  assert.equal(clearedAgain.doc.getText("t").toString(), "");
  assert.equal(clearedAgain.p.loadedUpdates, 0);
  const keptAgain = await reopen(db, "a/b");
  assert.equal(keptAgain.doc.getText("t").toString(), "kept");
  assert.equal(keptAgain.p.loadedUpdates, 1);
  await db.close();
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { noStorage, openDb } from "@opfs-lsm/kv";
import * as Y from "yjs";
import { KvPersistence } from "../src/index.ts";

const db = await openDb({ name: "yjs-no-storage" }).catch(noStorage);

function docName(): string {
  return randomUUID();
}

async function reopen(name: string): Promise<KvPersistence> {
  const p = new KvPersistence(db, name, new Y.Doc());
  await p.whenSynced;
  return p;
}

function twoUpdates(): [Uint8Array, Uint8Array] {
  const source = new Y.Doc();
  const updates: Uint8Array[] = [];
  source.on("update", (u: Uint8Array) => updates.push(u));
  source.getText("t").insert(0, "a");
  source.getText("t").insert(1, "b");
  return updates as [Uint8Array, Uint8Array];
}

test("the open gives no db in Node", () => {
  assert.equal(db, undefined);
});

test("a doc destroyed and attached again under its name keeps its content", async () => {
  const name = docName();
  const p = await reopen(name);
  assert.equal(p.synced, true);
  p.doc.getText("t").insert(0, "hello");
  await p.destroy();

  const again = await reopen(name);
  assert.equal(again.synced, true);
  assert.equal(again.doc.getText("t").toString(), "hello");
  await again.destroy();
});

test("content the doc held before the persistence was attached is kept", async () => {
  const name = docName();
  const doc = new Y.Doc();
  doc.getText("t").insert(0, "before");
  const p = new KvPersistence(db, name, doc);
  await p.whenSynced;
  await p.destroy();

  const again = await reopen(name);
  assert.equal(again.doc.getText("t").toString(), "before");
  await again.destroy();
});

test("an update that goes pending while attached is kept by destroy", async () => {
  const name = docName();
  const [first, second] = twoUpdates();
  const p = await reopen(name);
  Y.applyUpdate(p.doc, second, "provider");
  assert.ok(p.doc.store.pendingStructs);
  await p.destroy();

  const again = await reopen(name);
  Y.applyUpdate(again.doc, first);
  assert.equal(again.doc.getText("t").toString(), "ab");
  await again.destroy();
});

test("two names keep apart, also when one name starts with the other", async () => {
  const name = docName();
  const a = await reopen(name);
  const ab = await reopen(`${name}/b`);
  a.doc.getText("t").insert(0, "a");
  ab.doc.getText("t").insert(0, "ab");
  await a.destroy();
  await ab.destroy();

  const a2 = await reopen(name);
  const ab2 = await reopen(`${name}/b`);
  assert.equal(a2.doc.getText("t").toString(), "a");
  assert.equal(ab2.doc.getText("t").toString(), "ab");
  await a2.destroy();
  await ab2.destroy();
});

test("clearData forgets the doc", async () => {
  const name = docName();
  const p = await reopen(name);
  p.doc.getText("t").insert(0, "gone");
  await p.clearData();

  const again = await reopen(name);
  assert.equal(again.doc.getText("t").toString(), "");
  assert.equal(again.loadedUpdates, 0);
  await again.destroy();
});

test("the updates of a doc are merged once there are trimSize of them", async () => {
  const name = docName();
  const p = new KvPersistence(db, name, new Y.Doc(), 10);
  await p.whenSynced;
  for (let i = 0; i < 30; i++) p.doc.getText("t").insert(i, "x");
  await p.destroy();

  const again = await reopen(name);
  assert.ok(again.loadedUpdates < 10, `loaded ${again.loadedUpdates} updates`);
  assert.equal(again.doc.getText("t").toString(), "x".repeat(30));
  await again.destroy();
});

test("flush resolves", async () => {
  const p = await reopen(docName());
  p.doc.getText("t").insert(0, "x");
  await p.flush();
  await p.destroy();
});

import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ConstraintError, type Db } from "@opfs-lsm/kv";
import { openHarnessDb } from "@opfs-lsm/kv/testing";
import * as Y from "yjs";
import { KvPersistence } from "../src/index.ts";

function dbName(): string {
  return `yjs${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function reopen(db: Db, name: string, trim?: number) {
  const doc = new Y.Doc();
  const p = new KvPersistence(db, name, doc, trim);
  await p.whenSynced;
  return { doc, p };
}

test("content the doc held before the persistence was attached is stored as one entry", async (t) => {
  const db = await openHarnessDb({ name: dbName(), forceMemory: true });
  t.after(() => db.close());
  const doc = new Y.Doc();
  for (let i = 0; i < 5; i++) doc.getText("t").insert(i, "x");
  const p = new KvPersistence(db, "a", doc);
  await p.whenSynced;
  await p.destroy();
  const again = await reopen(db, "a");
  assert.equal(again.p.loadedUpdates, 1);
  assert.equal(again.doc.getText("t").toString(), "xxxxx");
});

test("by default a doc merges once it has 500 entries and goes quiet for a second", async (t) => {
  const db = await openHarnessDb({ name: dbName(), forceMemory: true });
  t.after(() => db.close());
  const open = await reopen(db, "doc");
  for (let i = 0; i < 499; i++) open.doc.getText("t").insert(i, "x");
  await open.p.flush();
  await sleep(1100);
  const under = await reopen(db, "doc", 1_000_000);
  assert.equal(under.p.loadedUpdates, 499, "no merge below 500");
  open.doc.getText("t").insert(499, "x");
  await open.p.flush();
  await sleep(500);
  const early = await reopen(db, "doc", 1_000_000);
  assert.equal(early.p.loadedUpdates, 500, "no merge before a quiet second");
  await sleep(700);
  await open.p.flush();
  await open.p.destroy();
  const merged = await reopen(db, "doc", 1_000_000);
  assert.equal(merged.p.loadedUpdates, 1);
  assert.equal(merged.doc.getText("t").toString(), "x".repeat(500));
});

test("whenSynced resolves without waiting for the merge a load schedules", async (t) => {
  const db = await openHarnessDb({ name: dbName(), forceMemory: true });
  t.after(() => db.close());
  const seed = await reopen(db, "doc", 10);
  seed.p.trimDelayMs = 1_000_000;
  for (let i = 0; i < 12; i++) seed.doc.getText("t").insert(i, "x");
  await seed.p.destroy();

  const p = new KvPersistence(db, "doc", new Y.Doc(), 10);
  p.trimDelayMs = 60_000;
  const synced = await Promise.race([p.whenSynced.then(() => "synced"), sleep(2000).then(() => "timeout")]);
  assert.equal(synced, "synced");
  await p.destroy();
});

test("a merge applies another tab's stored updates to this doc", async (t) => {
  const db = await openHarnessDb({ name: dbName(), forceMemory: true });
  t.after(() => db.close());
  const mine = await reopen(db, "doc", 10);
  const theirs = await reopen(db, "doc", 10);
  mine.p.trimDelayMs = 20;
  theirs.doc.getMap("m").set("theirs", 1);
  await theirs.p.flush();
  assert.equal(mine.doc.getMap("m").get("theirs"), undefined, "a persistence loads once");
  for (let i = 0; i < 10; i++) mine.doc.getMap("m").set(`k${i}`, i);
  await sleep(60);
  await mine.p.flush();
  assert.equal(mine.doc.getMap("m").get("theirs"), 1);
  await mine.p.destroy();
  await theirs.p.destroy();
});

test("every key the persistence stores starts with the byte y", async (t) => {
  const db = await openHarnessDb({ name: dbName(), forceMemory: true });
  t.after(() => db.close());
  const a = await reopen(db, "", 3);
  a.p.trimDelayMs = 0;
  for (let i = 0; i < 5; i++) a.doc.getText("t").insert(i, "x");
  await sleep(20);
  await a.p.destroy();
  const keys: number[] = [];
  for await (const entry of db.range({})) keys.push(entry.key[0]!);
  assert.ok(keys.length > 0);
  assert.deepEqual(new Set(keys), new Set([0x79]));
});

test("an update over 8 MiB rejects flush with ConstraintError", async (t) => {
  const db = await openHarnessDb({ name: dbName(), forceMemory: true });
  t.after(() => db.close());
  const { doc, p } = await reopen(db, "big");
  doc.getText("t").insert(0, "x".repeat(9 << 20));
  await assert.rejects(p.flush(), ConstraintError);
  await assert.rejects(p.destroy(), ConstraintError);
});

test("a name fits while its update keys fit 8 KiB, and a longer one rejects whenSynced with ConstraintError", async (t) => {
  const db = await openHarnessDb({ name: dbName(), forceMemory: true });
  t.after(() => db.close());
  // A key is the 3-byte prefix, the name, then 8 bytes of session and seq.
  const { doc, p } = await reopen(db, "x".repeat(8181));
  doc.getText("t").insert(0, "x");
  await p.flush();
  for (const length of [8182, 70_000]) {
    await assert.rejects(new KvPersistence(db, "x".repeat(length), new Y.Doc()).whenSynced, ConstraintError);
  }
});

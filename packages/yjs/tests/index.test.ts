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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

test("a doc loaded at the trim size merges its updates into one once it goes quiet", async () => {
  const db = await openHarnessDb({ name: dbName(), forceMemory: true });
  const first = await reopen(db, "doc", 10);
  for (let i = 0; i < 12; i++) first.doc.getText("t").insert(i, "x");
  await first.p.destroy();

  const doc = new Y.Doc();
  const second = new KvPersistence(db, "doc", doc, 10);
  second.trimDelayMs = 20;
  await second.whenSynced;
  assert.equal(second.loadedUpdates, 12);
  await sleep(40);
  await second.flush();
  const third = await reopen(db, "doc", 10);
  assert.equal(third.p.loadedUpdates, 1);
  assert.equal(third.doc.getText("t").toString(), "x".repeat(12));
  await db.close();
});

test("an open doc merges its updates once it has trimSize of them and goes quiet", async () => {
  const db = await openHarnessDb({ name: dbName(), forceMemory: true });
  const open = await reopen(db, "doc", 10);
  open.p.trimDelayMs = 20;
  for (let i = 0; i < 12; i++) open.doc.getText("t").insert(i, "x");
  await open.p.flush();
  await sleep(40);
  await open.p.flush();
  open.doc.getText("t").insert(12, "y");
  await open.p.destroy();

  const again = await reopen(db, "doc", 10);
  assert.equal(again.p.loadedUpdates, 2, "the merged state and the update after it");
  assert.equal(again.doc.getText("t").toString(), "x".repeat(12) + "y");
  await db.close();
});

test("a merge while open keeps the updates another tab stored after this one loaded", async () => {
  const db = await openHarnessDb({ name: dbName(), forceMemory: true });
  const mine = await reopen(db, "doc", 10);
  const theirs = await reopen(db, "doc", 10);
  mine.p.trimDelayMs = 20;
  theirs.doc.getMap("m").set("theirs", 1);
  await theirs.p.flush();
  for (let i = 0; i < 10; i++) mine.doc.getMap("m").set(`k${i}`, i);
  await mine.p.flush();
  await sleep(40);
  await mine.p.flush();
  await mine.p.destroy();
  await theirs.p.destroy();

  const again = await reopen(db, "doc", 10);
  assert.equal(again.p.loadedUpdates, 1, "the merge replaced both tabs' updates");
  assert.equal(again.doc.getMap("m").get("theirs"), 1);
  assert.equal(again.doc.getMap("m").size, 11);
  await db.close();
});

test("a merge keeps an update another tab stores between the merge's read and its write", async () => {
  const db = await openHarnessDb({ name: dbName(), forceMemory: true });
  const seed = await reopen(db, "doc", 1000);
  for (let i = 0; i < 12; i++) seed.doc.getText("t").insert(i, "x");
  await seed.p.destroy();

  const theirs = await reopen(db, "doc", 1000);
  const late = async () => {
    theirs.doc.getMap("m").set("late", 1);
    await theirs.p.flush();
  };
  const racing = new Proxy(db, {
    get(target, key) {
      if (key === "batch") return async (build: Parameters<Db["batch"]>[0]) => (await late(), target.batch(build));
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const mine = new KvPersistence(racing, "doc", new Y.Doc(), 10);
  mine.trimDelayMs = 20;
  await mine.whenSynced;
  await sleep(40);
  await mine.flush();
  await mine.destroy();
  await theirs.p.destroy();

  const again = await reopen(db, "doc", 1000);
  assert.equal(again.p.loadedUpdates, 2, "the merged state and the update stored during the merge");
  assert.equal(again.doc.getText("t").toString(), "x".repeat(12));
  assert.equal(again.doc.getMap("m").get("late"), 1);
  await db.close();
});

test("destroy cancels a merge that is waiting for the doc to go quiet", async () => {
  const db = await openHarnessDb({ name: dbName(), forceMemory: true });
  const open = await reopen(db, "doc", 10);
  open.p.trimDelayMs = 20;
  for (let i = 0; i < 12; i++) open.doc.getText("t").insert(i, "x");
  await open.p.destroy();
  await sleep(40);

  const again = await reopen(db, "doc", 1000);
  assert.equal(again.p.loadedUpdates, 12);
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

/** `db` whose `put` rejects while `failing()` is true. */
function flaky(db: Db, failing: () => boolean): Db {
  return new Proxy(db, {
    get(target, key) {
      if (key === "put" && failing()) return () => Promise.reject(new Error("disk full"));
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("a flush after a failed write stores the whole doc again", async () => {
  const db = await openHarnessDb({ name: dbName(), forceMemory: true });
  let fail = false;
  const doc = new Y.Doc();
  const p = new KvPersistence(flaky(db, () => fail), "a", doc);
  await p.whenSynced;
  doc.getText("t").insert(0, "one ");
  fail = true;
  doc.getText("t").insert(4, "two ");
  fail = false;
  doc.getText("t").insert(8, "three");
  await p.flush();
  await p.destroy();

  const again = await reopen(db, "a");
  assert.equal(again.doc.getText("t").toString(), "one two three");
  await db.close();
});

test("flush rejects while the repair write fails, and resolves once it lands", async () => {
  const db = await openHarnessDb({ name: dbName(), forceMemory: true });
  let fail = true;
  const doc = new Y.Doc();
  const p = new KvPersistence(flaky(db, () => fail), "a", doc);
  await p.whenSynced;
  doc.getText("t").insert(0, "lost");
  await assert.rejects(p.flush(), /disk full/);
  await assert.rejects(p.flush(), /disk full/);
  fail = false;
  await p.flush();
  await p.flush();
  await p.destroy();

  const again = await reopen(db, "a");
  assert.equal(again.doc.getText("t").toString(), "lost");
  await db.close();
});

test("every flush running when the repair write fails rejects", async () => {
  const db = await openHarnessDb({ name: dbName(), forceMemory: true });
  const doc = new Y.Doc();
  const p = new KvPersistence(flaky(db, () => true), "a", doc);
  await p.whenSynced;
  doc.getText("t").insert(0, "lost");
  const results = await Promise.allSettled([p.flush(), p.flush()]);
  await db.close();
  assert.deepEqual(results.map((r) => r.status), ["rejected", "rejected"]);
});

test("a failed write with no flush waiting is not an unhandled rejection", async () => {
  const db = await openHarnessDb({ name: dbName(), forceMemory: true });
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", record);
  try {
    const doc = new Y.Doc();
    const p = new KvPersistence(flaky(db, () => true), "a", doc);
    await p.whenSynced;
    doc.getText("t").insert(0, "x");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(unhandled, []);
    await assert.rejects(p.destroy(), /disk full/);
  } finally {
    process.off("unhandledRejection", record);
    await db.close();
  }
});

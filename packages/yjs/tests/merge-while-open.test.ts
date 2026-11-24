/**
 * The README merges a doc "whether it reached 500 at load or while
 * open". A doc that loads under the threshold and crosses it with updates made
 * while open must count the loaded entries too.
 */
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

test("a doc that loads under trimSize merges once updates made while open bring it to trimSize", async (t) => {
  const db = await openHarnessDb({ name: dbName(), forceMemory: true });
  t.after(() => db.close());
  const seed = await reopen(db, "doc", 1000);
  for (let i = 0; i < 6; i++) seed.doc.getText("t").insert(i, "a");
  await seed.p.destroy();

  const open = await reopen(db, "doc", 10);
  assert.equal(open.p.loadedUpdates, 6);
  open.p.trimDelayMs = 20;
  for (let i = 0; i < 4; i++) open.doc.getText("t").insert(0, "b");
  await sleep(80);
  await open.p.destroy();

  const again = await reopen(db, "doc", 1000);
  assert.equal(again.p.loadedUpdates, 1);
  assert.equal(again.doc.getText("t").toString(), "bbbbaaaaaa");
  await again.p.destroy();
});

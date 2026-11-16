import "fake-indexeddb/auto";
import type { StorageAdapterInterface } from "@automerge/automerge-repo";
import { openHarnessDb } from "@opfs-lsm/kv/testing";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { kvStorage } from "@opfs-lsm/automerge";
import { newPageId } from "../src/model/bodies.ts";
import { PagesError } from "../src/model/errors.ts";
import { openNotes } from "../src/model/notes.ts";
import type { SaveState, TextEdit } from "../src/model/types.ts";
import { memoryStorage } from "../src/storage/memory.ts";

const isInvalid = (error: unknown) => error instanceof PagesError && error.kind === "invalid";
const isStorage = (error: unknown) => error instanceof PagesError && error.kind === "storage";

test("edits that would break the body are refused, and a refused batch changes nothing", async (t) => {
  const notes = await openNotes({ storage: memoryStorage() });
  t.after(() => notes.close());
  const body = await notes.bodies.open(newPageId());
  body.edit([{ type: "insert", at: 1, text: "ab", marks: {} }]);
  const before = body.spans();

  const refused: TextEdit[][] = [
    [{ type: "delete", at: 0, count: 1 }],
    [{ type: "insert", at: 0, text: "x", marks: {} }],
    [{ type: "split", at: 0, block: { type: "paragraph" } }],
    [{ type: "setBlock", at: 1, block: { type: "heading", level: 1 } }],
    [{ type: "insert", at: 99, text: "x", marks: {} }],
    [{ type: "mark", start: 2, end: 2, name: "bold", value: true }],
    [
      { type: "insert", at: 1, text: "kept?", marks: {} },
      { type: "delete", at: 0, count: 1 },
    ],
  ];
  for (const edits of refused) {
    assert.throws(() => body.edit(edits), isInvalid, JSON.stringify(edits));
    assert.deepEqual(body.spans(), before, `no change after ${JSON.stringify(edits)}`);
  }
  body.edit([{ type: "setBlock", at: 0, block: { type: "todo", depth: 1, checked: true } }]);
  assert.deepEqual(body.spans(), [
    { type: "block", block: { type: "todo", depth: 1, checked: true } },
    { type: "text", text: "ab", marks: {} },
  ]);
});

test("the save view goes saving, saved, error, and back to saved", async (t) => {
  const inner = memoryStorage();
  let failing = false;
  const storage: StorageAdapterInterface = {
    ...inner,
    async save(key, data) {
      if (failing) throw new Error("quota");
      await inner.save(key, data);
    },
  };
  const notes = await openNotes({ storage });
  t.after(() => notes.close());
  const body = await notes.bodies.open(newPageId());
  const seen: SaveState["state"][] = [];
  body.save.subscribe(() => seen.push(body.save.read().state));

  assert.equal(body.save.read().state, "saving", "a seeded body is not stored yet");
  await body.flush();
  assert.equal(body.save.read().state, "saved");

  body.edit([{ type: "insert", at: 1, text: "a", marks: {} }]);
  assert.equal(body.save.read().state, "saving");
  assert.equal(body.save.read(), body.save.read(), "read returns the same object until it changes");

  failing = true;
  await assert.rejects(body.flush(), isStorage);
  const failed = body.save.read();
  assert.equal(failed.state, "error");
  assert.ok(failed.state === "error" && isStorage(failed.error));

  failing = false;
  await body.flush();
  assert.equal(body.save.read().state, "saved", "a later save clears the error");
  assert.deepEqual(seen, ["saved", "saving", "error", "saved"]);
});

test("open rejects with storage when the stored body cannot be read, and seeds nothing", async (t) => {
  const inner = memoryStorage();
  const id = newPageId();
  const first = await openNotes({ storage: inner });
  (await first.bodies.open(id)).edit([{ type: "insert", at: 1, text: "keep me", marks: {} }]);
  await first.close();

  let broken = true;
  const saves: string[] = [];
  const flaky: StorageAdapterInterface = {
    ...inner,
    async loadRange(prefix) {
      if (broken && prefix[0] === id) throw new Error("read failed");
      return inner.loadRange(prefix);
    },
    async save(key, data) {
      if (key[0] === id) saves.push(key.join("/"));
      await inner.save(key, data);
    },
  };
  const notes = await openNotes({ storage: flaky });
  t.after(() => notes.close());
  await assert.rejects(notes.bodies.open(id), isStorage);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(saves, [], "no seed was written over the unreadable body");

  broken = false;
  const body = await notes.bodies.open(id);
  assert.deepEqual(body.spans()[1], { type: "text", text: "keep me", marks: {} });
});

test("closing the model leaves the caller's kv db open", async () => {
  const db = await openHarnessDb({ name: `notes${randomUUID().replaceAll("-", "").slice(0, 20)}`, forceMemory: true });
  const notes = await openNotes({ storage: kvStorage(db) });
  const page = notes.createPage(null);
  (await notes.bodies.open(page)).edit([{ type: "insert", at: 1, text: "on kv", marks: { code: true } }]);
  await notes.close();

  const key = new Uint8Array([0x01]);
  await db.put(key, new Uint8Array([1]));
  assert.deepEqual(await db.get(key), new Uint8Array([1]), "the db still reads and writes");
  const again = await openNotes({ storage: kvStorage(db) });
  assert.deepEqual(again.tree.read().children(null), [page], "the list reopens");
  assert.deepEqual((await again.bodies.open(page)).spans()[1], { type: "text", text: "on kv", marks: { code: true } });
  await again.close();
  await db.close();
});

import { expect, test } from "vitest";
import { toBase64url } from "../src/bytes.js";
import { SpacesError } from "../src/errors.js";
import { keyedRecordId, recordBytes } from "../src/ids.js";
import { fieldHash, indexBounds, richTextBounds, outboxRichTextBounds } from "../src/local/keys.js";
import { Clock } from "../src/local/record.js";
import type { WriteOp } from "../src/local/store.js";
import {
  coll,
  del,
  newId,
  openTab,
  patchOf,
  put,
  randomSpace,
  recordItem,
  serverPage,
  remoteState,
  uniqueName,
} from "./local-util.js";

async function rejects(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SpacesError);
  expect((err as SpacesError).code).toBe(code);
}

const row = async (tab: Awaited<ReturnType<typeof openTab>>, name: string, id: Uint8Array) =>
  tab.store.get(coll(tab, name), id as never);

test("two tabs updating different fields of one record concurrently keep both", async () => {
  const name = uniqueName();
  const a = await openTab(name);
  const b = await openTab(name);
  const space = randomSpace();
  const id = newId(space);
  const list = newId(space);
  await put(a, "todos", id, { list: toBase64url(list), title: "x", position: "a" }, true);
  await b.kv.sync();
  await Promise.all([put(a, "todos", id, { title: "from a" }), put(b, "todos", id, { done: true })]);
  await a.kv.sync();
  await b.kv.sync();
  for (const tab of [a, b]) {
    expect(await row(tab, "todos", id)).toMatchObject({ title: "from a", done: true, position: "a" });
  }
});

test("a local write beats the stamp it overwrote even when the wall clock is behind", async () => {
  const tab = await openTab(uniqueName(), undefined, () => 1_000);
  const space = randomSpace();
  const id = newId(space);
  const far = new Clock(5, () => 9_000_000_000_000);
  const state = remoteState("lists", { title: "remote" }, far);
  await tab.store.applyRemote(serverPage(space, [recordItem(id, 1, state)], 1));
  expect(await row(tab, "lists", id)).toMatchObject({ title: "remote" });
  await put(tab, "lists", id, { title: "local" });
  expect(await row(tab, "lists", id)).toMatchObject({ title: "local" });
  // and a later local write still beats the first one
  await put(tab, "lists", id, { title: "local 2" });
  expect(await row(tab, "lists", id)).toMatchObject({ title: "local 2" });
});

test("delete is terminal and removes index entries and rich-text keys", async () => {
  const tab = await openTab(uniqueName());
  const space = randomSpace();
  const id = newId(space);
  const todos = coll(tab, "todos");
  await put(tab, "todos", id, { list: toBase64url(newId(space)), title: "t", position: "p" }, true);
  const field = fieldHash("body");
  await tab.store.appendRichText(id, field, 1, 1, new Uint8Array([1, 2, 3]));
  const count = async (b: { start?: Uint8Array; endExclusive?: Uint8Array }) => tab.kv.count(b);
  const entries = async () => {
    let n = 0;
    for (const ix of todos.indexes) n += await count(indexBounds(todos.id, ix.id));
    return n;
  };
  expect(await entries()).toBe(2);
  expect(await count(richTextBounds(id))).toBe(1);
  expect(await count(outboxRichTextBounds(id))).toBe(1);

  await del(tab, "todos", id);
  expect(await entries()).toBe(0);
  expect(await count(richTextBounds(id))).toBe(0);
  expect(await count(outboxRichTextBounds(id))).toBe(0);
  expect(await row(tab, "todos", id)).toBeUndefined();
  expect(await tab.store.status(todos, id)).toBe("deleted");
  await rejects(put(tab, "todos", id, { title: "again" }), "deleted");
  await rejects(tab.store.appendRichText(id, field, 1, 2, new Uint8Array([9])), "not-found");
  // idempotent
  await del(tab, "todos", id);
  const pending = await tab.store.pendingRecords(new Uint8Array(id.subarray(0, 8)) as never, 10);
  expect(pending.map((p) => p.kind)).toEqual(["tomb"]);
});

test("creating a deleted keyedRecordId throws deleted", async () => {
  const tab = await openTab(uniqueName());
  const space = randomSpace();
  const id = recordBytes(await keyedRecordId(space, "lists", "profile"));
  expect(recordBytes(await keyedRecordId(space, "lists", "profile"))).toEqual(id);
  await put(tab, "lists", id, { title: "me" }, true);
  await del(tab, "lists", id);
  await rejects(put(tab, "lists", id, { title: "me again" }, true), "deleted");
  expect(await row(tab, "lists", id)).toBeUndefined();
});

test("update of a missing record is not-found, create of an existing one fails, and a failing op aborts the batch", async () => {
  const tab = await openTab(uniqueName());
  const space = randomSpace();
  const a = newId(space);
  const b = newId(space);
  await rejects(put(tab, "lists", a, { title: "x" }), "not-found");
  await put(tab, "lists", a, { title: "x" }, true);
  await rejects(put(tab, "lists", a, { title: "y" }, true), "validation");
  const ops: WriteOp[] = [
    { kind: "put", coll: coll(tab, "lists"), id: b, create: true, patch: patchOf({ title: "b" }), files: [] },
    { kind: "put", coll: coll(tab, "lists"), id: newId(space), create: false, patch: patchOf({ title: "c" }), files: [] },
  ];
  await rejects(tab.store.write(ops), "not-found");
  expect(await row(tab, "lists", b)).toBeUndefined();
});

test("two ops on one record in one transaction see each other", async () => {
  const tab = await openTab(uniqueName());
  const id = newId(randomSpace());
  const lists = coll(tab, "lists");
  await tab.store.write([
    { kind: "put", coll: lists, id, create: true, patch: patchOf({ title: "a" }), files: [] },
    { kind: "put", coll: lists, id, create: false, patch: patchOf({ title: "b" }), files: [] },
  ]);
  expect(await row(tab, "lists", id)).toMatchObject({ title: "b" });
});

test("a file is owned by the first record that stores it", async () => {
  const tab = await openTab(uniqueName());
  const space = randomSpace();
  const fileId = recordBytes(await keyedRecordId(space, "files", "f")) as never;
  await tab.store.putFileChunks(fileId, 0, [new Uint8Array([1]), new Uint8Array([2])], { size: 2, chunks: 2, have: 2 });
  const fileText = toBase64url(fileId);
  const ref = { id: fileText, name: "a.png", type: "image/png", size: 2, key: "k" };
  const todos = coll(tab, "todos");
  const base = { list: toBase64url(newId(space)), title: "t", position: "p" };
  const one = newId(space);
  const two = newId(space);
  const op = (id: typeof one, create: boolean): WriteOp => ({
    kind: "put",
    coll: todos,
    id,
    create,
    patch: patchOf({ ...base, image: ref }),
    files: [fileId],
  });
  await tab.store.write([op(one, true)]);
  expect((await tab.store.readManifest(fileId))?.owner).toEqual(one);
  expect(await tab.store.pendingFiles("upload", 10)).toHaveLength(1);
  await rejects(tab.store.write([op(two, true)]), "file-attached");
  await tab.store.write([op(one, false)]); // the owner may write it again
  await del(tab, "todos", one);
  expect(await tab.store.readManifest(fileId)).toBeUndefined();
  expect(await tab.store.readFileChunks(fileId, 0, 2)).toEqual([undefined, undefined]);
  expect(await tab.store.pendingFiles("upload", 10)).toHaveLength(0);
});

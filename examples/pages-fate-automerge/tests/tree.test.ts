import assert from "node:assert/strict";
import { test } from "node:test";
import { newPageId } from "../src/model/bodies.ts";
import { childrenRequest, createPage, deletePage, pageRequest, renamePage, TREE_REQUEST, type Fate } from "../src/model/tree.ts";
import type { PageId } from "../src/model/types.ts";
import { memoryPagesStorage } from "../src/storage/memory.ts";
import { cachedIds, delivered, until, workspace } from "./workspace.ts";

const titleOf = (fate: Fate, id: PageId) => (fate.store.read(`Page:${id}`) as { title?: string } | undefined)?.title;

test("new pages show at the end of their parent's level at once, and the server keeps that order", async (t) => {
  const { open, serverIds } = workspace();
  const fate = await open(memoryPagesStorage().fate);
  t.after(() => fate.persistence!.dispose());
  const a = await createPage(fate, { parent: null });
  const b = await createPage(fate, { parent: null });
  const a1 = await createPage(fate, { parent: a });
  const a2 = await createPage(fate, { parent: a });
  assert.deepEqual(await cachedIds(fate, null), [a, b], "top level before the server answers");
  assert.deepEqual(await cachedIds(fate, a), [a1, a2], "A's level before the server answers");
  await delivered(fate);
  assert.deepEqual(serverIds(null), [a, b]);
  assert.deepEqual(serverIds(a), [a1, a2]);
});

test("a rename trims, shows at once, and an unchanged title sends nothing", async (t) => {
  const { open, serverIds } = workspace();
  const fate = await open(memoryPagesStorage().fate);
  t.after(() => fate.persistence!.dispose());
  const id = await createPage(fate, { parent: null });
  await delivered(fate);
  await renamePage(fate, id, "  Meeting notes  ");
  assert.equal(titleOf(fate, id), "Meeting notes", "the cache holds the new title before the server answers");
  await delivered(fate);
  await renamePage(fate, id, "Meeting notes ");
  assert.equal(fate.persistence!.getSnapshot().mutations.length, 0, "the same title queues nothing");
  const fresh = await fate.request(pageRequest(id), { mode: "network-only" });
  assert.ok(fresh.page, "the header reads from the server");
  assert.equal(titleOf(fate, id), "Meeting notes", "the server holds it");
  assert.deepEqual(serverIds(null), [id]);
});

test("a delete leaves every cached list at once, and the server drops the subtree", async (t) => {
  const { open, serverIds } = workspace();
  const fate = await open(memoryPagesStorage().fate);
  t.after(() => fate.persistence!.dispose());
  const a = await createPage(fate, { parent: null });
  const b = await createPage(fate, { parent: null });
  const a1 = await createPage(fate, { parent: a });
  await createPage(fate, { parent: a1 });
  await delivered(fate);
  await deletePage(fate, a);
  assert.deepEqual(await cachedIds(fate, null), [b], "A left the top level before the server answered");
  await delivered(fate);
  assert.deepEqual(serverIds(null), [b]);
  assert.deepEqual([serverIds(a), serverIds(a1)], [[], []], "A's children are gone on the server");
});

test("a create the server refuses rolls back and stays failed until it is discarded", async (t) => {
  const { open } = workspace();
  const fate = await open(memoryPagesStorage().fate);
  t.after(() => fate.persistence!.dispose());
  const gone = newPageId();
  await createPage(fate, { parent: gone });
  await delivered(fate);
  const [entry] = fate.persistence!.getSnapshot().mutations;
  assert.equal(entry?.status, "failed", "the refusal is kept");
  assert.deepEqual(await cachedIds(fate, gone), [], "the optimistic page left the level");
  await fate.persistence!.discard(entry!.id);
  assert.equal(fate.persistence!.getSnapshot().mutations.length, 0, "discard empties the journal");
});

test("a reload with the server down paints the cached levels and header; an uncached level fails", async () => {
  const { net, open } = workspace();
  const storage = memoryPagesStorage().fate;
  const first = await open(storage);
  const a = await createPage(first, { parent: null });
  const b = await createPage(first, { parent: null });
  const a1 = await createPage(first, { parent: a });
  await delivered(first);
  await first.request(childrenRequest(null), TREE_REQUEST);
  await first.request(childrenRequest(a), TREE_REQUEST);
  // A page created on this device is already cached, so this read answers at once; it is kept once its refresh lands.
  const answered = net.answered;
  await first.request(pageRequest(a1), TREE_REQUEST);
  await until(() => net.answered > answered, "the header's background refresh");
  await new Promise((resolve) => setImmediate(resolve));
  await first.persistence!.flush();
  first.persistence!.dispose();

  net.up = false;
  const second = await open(storage);
  try {
    const top = await second.request(childrenRequest(null), TREE_REQUEST);
    assert.deepEqual(top.children.items.map((item) => item.node.id), [a, b], "top level from the device");
    const level = await second.request(childrenRequest(a), TREE_REQUEST);
    assert.deepEqual(level.children.items.map((item) => item.node.id), [a1], "A's level from the device");
    assert.ok((await second.request(pageRequest(a1), TREE_REQUEST)).page, "the page header resolves");
    assert.equal((second.store.read(`Page:${a1}`) as { parentId?: PageId } | undefined)?.parentId, a, "the page header from the device");
    await assert.rejects(second.request(childrenRequest(b), TREE_REQUEST), /Failed to fetch/, "B's level was never fetched");
  } finally {
    second.persistence!.dispose();
  }
});

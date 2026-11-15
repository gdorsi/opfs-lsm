import { createHTTPTransport } from "@nkzw/fate";
import type { PersistenceStorage } from "@nkzw/fate/persistence";
import assert from "node:assert/strict";
import { test } from "node:test";
import { newPageId } from "../src/model/bodies.ts";
import { childrenRequest, createPage, createTreeClient, deletePage, pageRequest, renamePage, TREE_REQUEST, type Fate } from "../src/model/tree.ts";
import type { PageId } from "../src/model/types.ts";
import { openServerDb } from "../src/server/db.ts";
import { readChildren } from "../src/server/pages.ts";
import { createServer } from "../src/server/fate.ts";
import { memoryPagesStorage } from "../src/storage/memory.ts";

/** A tree client and the server it talks to in process. `up = false` makes every request fail as an unreachable server does. */
function workspace() {
  const db = openServerDb(":memory:");
  const server = createServer(db);
  const net = { up: true, answered: 0 };
  const transport = createHTTPTransport({
    url: "http://pages/api/fate",
    live: false,
    fetch: async (input, init) => {
      if (!net.up) throw new TypeError("Failed to fetch");
      const response = await server.handleRequest(new Request(input, init));
      net.answered++;
      return response;
    },
  });
  const open = async (storage: PersistenceStorage) => {
    const fate = createTreeClient({ transport, storage, online: () => true });
    await fate.persistence!.ready;
    return fate;
  };
  /** What the server holds, read from its database. */
  const serverIds = (parent: PageId | null) => readChildren(db, { parent, first: 200 }).rows.map((row) => row.id);
  return { net, open, serverIds };
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const delivered = (fate: Fate) => until(() => fate.persistence!.getSnapshot().mutations.every((m) => m.status === "failed"), "the server to answer the queue");

/** The ids the device holds for `parent`'s children, or null when the level is not cached. No request. */
async function cachedIds(fate: Fate, parent: PageId | null): Promise<PageId[] | null> {
  const observer = fate.observeRequest(childrenRequest(parent), { mode: "cache-only" });
  await until(() => observer.getSnapshot().status !== "pending", "the cache to answer");
  const snapshot = observer.getSnapshot();
  return snapshot.status === "ready" ? snapshot.data!.children.items.map((item) => item.node.id as PageId) : null;
}

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

import type { StorageAdapterInterface } from "@automerge/automerge-repo";
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel";
import assert from "node:assert/strict";
import { test } from "node:test";
import { openNotes } from "../src/model/notes.ts";
import type { PageId } from "../src/model/types.ts";
import { memoryStorage } from "../src/storage/memory.ts";
import { stored, tab, twoTabs, typed, until, write } from "./workspace.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const allGone = (storage: StorageAdapterInterface, ids: readonly PageId[]) => async () =>
  (await Promise.all(ids.map((id) => stored(storage, id)))).every((has) => !has);

test("a delete removes the bodies of the page and its descendants, and no others, in both tabs", async (t) => {
  const storage = memoryStorage();
  const [A, B] = await twoTabs(t, [storage, storage]);
  const a = A.createPage(null);
  const b = A.createPage(null);
  const a1 = A.createPage(a);
  const a11 = A.createPage(a1);
  await write(A, [a, b, a1, a11]);
  await until(() => B.tree.read().page(a11) !== undefined, "B to see the tree");
  const [inA, inB] = await Promise.all([A.bodies.open(a11), B.bodies.open(a1)]);

  A.deletePage(a);
  await until(() => inA.save.read().state === "removed" && inB.save.read().state === "removed", "both tabs to remove their open bodies");
  await until(allGone(storage, [a, a1, a11]), "the subtree's bodies to go");
  assert.ok(await stored(storage, b), "B's body stays");
  assert.equal((await B.bodies.open(b)).spans().length, 2, "and still opens with its text");
});

test("a body a peer edits after the delete is not written back", async (t) => {
  const [storageA, storageB] = [memoryStorage(), memoryStorage()];
  const [A, B] = await twoTabs(t, [storageA, storageB]);
  const id = A.createPage(null);
  await until(() => B.tree.read().page(id) !== undefined, "B to see the page");
  const [mine, peer] = await Promise.all([A.bodies.open(id), B.bodies.open(id)]);
  mine.edit(typed("mine"));
  await until(() => peer.spans().length > 1, "B to receive the edit");

  A.deletePage(id);
  peer.edit(typed("peer"));
  await until(() => peer.save.read().state === "removed", "B to remove its copy once the delete arrives");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(await storageA.loadRange([id]), [], "A stored nothing of B's edit");
  assert.deepEqual(await storageB.loadRange([id]), [], "B kept nothing either");
});

test("a body a tab holds only from sync is not written back after the delete when a new tab joins", async (t) => {
  const storage = memoryStorage();
  const channelName = `reclaim-${Math.random()}`;
  const join = async () => {
    const notes = await openNotes({ storage, saveDebounceMs: 1, network: [new BroadcastChannelNetworkAdapter({ channelName })] });
    t.after(() => notes.close());
    return notes;
  };
  const A = await join();
  const B = await join();
  const id = A.createPage(null);
  await until(() => B.tree.read().page(id) !== undefined, "B to see the page");
  (await A.bodies.open(id)).edit(typed("deleted text"));
  await sleep(300);

  A.deletePage(id);
  await until(allGone(storage, [id]), "the body to go");
  await sleep(100);
  await join();
  await sleep(500);
  assert.deepEqual(await storage.loadRange([id]), [], "no tab wrote the deleted body back");
});

test("a delete that races the body's sync leaves nothing for a tab that joins later", async (t) => {
  const storage = memoryStorage();
  const channelName = `reclaim-${Math.random()}`;
  const join = async () => {
    const notes = await openNotes({ storage, saveDebounceMs: 1, network: [new BroadcastChannelNetworkAdapter({ channelName })] });
    t.after(() => notes.close());
    return notes;
  };
  const A = await join();
  const B = await join();
  const id = A.createPage(null);
  await until(() => B.tree.read().page(id) !== undefined, "B to see the page");
  (await A.bodies.open(id)).edit(typed("deleted text"));
  A.deletePage(id);
  await sleep(500);
  await join();
  await sleep(800);
  assert.deepEqual(await storage.loadRange([id]), [], "no tab wrote anything under the deleted id");
});

test("a tab that opens a list holding an entry it cannot reach removes that entry's body", async (t) => {
  const storage = memoryStorage();
  const first = await openNotes({ storage });
  const parent = first.createPage(null);
  await first.close();

  const [A, B] = [await openNotes({ storage }), await openNotes({ storage })];
  A.deletePage(parent);
  const child = B.createPage(parent);
  await write(B, [child]);
  await Promise.all([A.close(), B.close()]);
  assert.ok(await stored(storage, child));

  const notes = await tab(t, storage);
  assert.equal(notes.tree.read().page(child), undefined, "the child is hidden");
  await until(allGone(storage, [child]), "the child's body to go");
});

import type { StorageAdapterInterface } from "@automerge/automerge-repo";
import type { PersistenceStorage } from "@nkzw/fate/persistence";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { newPageId, openBodies, type Bodies } from "../src/model/bodies.ts";
import { createPage, deletePage, reclaimBodies, type Fate } from "../src/model/tree.ts";
import type { PageId } from "../src/model/types.ts";
import { memoryBodies, memoryPagesStorage } from "../src/storage/memory.ts";
import { delivered, until, workspace } from "./workspace.ts";

function device(t: TestContext) {
  const storage = { fate: memoryPagesStorage().fate, bodies: memoryBodies() };
  const bodies = openBodies({ storage: storage.bodies });
  t.after(() => bodies.close());
  return { storage, bodies };
}

async function write(bodies: Bodies, ids: readonly PageId[]): Promise<void> {
  for (const id of ids) {
    const body = await bodies.open(id);
    body.edit([{ type: "insert", at: 1, text: `body of ${id}`, marks: {} }]);
    await body.close();
  }
}

const stored = async (storage: StorageAdapterInterface, id: PageId) => (await storage.loadRange([id])).length > 0;
const allGone = (storage: StorageAdapterInterface, ids: readonly PageId[]) => async () =>
  (await Promise.all(ids.map((id) => stored(storage, id)))).every((has) => !has);

function watch(t: TestContext, fate: Fate, bodies: Bodies) {
  const stop = reclaimBodies(fate, bodies);
  t.after(() => {
    stop();
    fate.persistence!.dispose();
  });
}

test("a confirmed delete removes the bodies of the page and its cached descendants, and no others", async (t) => {
  const { open } = workspace();
  const { storage, bodies } = device(t);
  const fate = await open(storage.fate);
  watch(t, fate, bodies);
  const a = await createPage(fate, { parent: null });
  const b = await createPage(fate, { parent: null });
  const a1 = await createPage(fate, { parent: a });
  const a11 = await createPage(fate, { parent: a1 });
  await delivered(fate);
  await write(bodies, [a, b, a1, a11]);

  await deletePage(fate, a);
  await delivered(fate);
  await until(allGone(storage.bodies, [a, a1, a11]), "A, A1 and A11's bodies to go");
  assert.ok(await stored(storage.bodies, b), "B's body stays");
});

test("a queued delete keeps the bodies until the server confirms it", async (t) => {
  const { open, net } = workspace();
  const { storage, bodies } = device(t);
  const fate = await open(storage.fate);
  watch(t, fate, bodies);
  const a = await createPage(fate, { parent: null });
  await delivered(fate);
  await write(bodies, [a]);

  net.up = false;
  await deletePage(fate, a);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(fate.persistence!.getSnapshot().mutations.length, 1, "the delete waits in the journal");
  assert.ok(await stored(storage.bodies, a), "the body stays while the delete is queued");

  net.up = true;
  fate.persistence!.retry();
  await until(allGone(storage.bodies, [a]), "the body to go after delivery");
});

test("a delete queued offline and delivered after a reload still frees the bodies", async (t) => {
  const { open, net } = workspace();
  const { storage, bodies } = device(t);
  const first = await open(storage.fate);
  const stopFirst = reclaimBodies(first, bodies);
  const a = await createPage(first, { parent: null });
  const a1 = await createPage(first, { parent: a });
  await delivered(first);
  await write(bodies, [a, a1]);
  net.up = false;
  await deletePage(first, a);
  await first.persistence!.flush();
  stopFirst();
  first.persistence!.dispose();

  net.up = true;
  const second = await open(storage.fate);
  watch(t, second, bodies);
  await delivered(second);
  await until(allGone(storage.bodies, [a, a1]), "both bodies to go after the reload's delivery");
});

test("a refused create keeps its body until the refusal is discarded", async (t) => {
  const { open } = workspace();
  const { storage, bodies } = device(t);
  const fate = await open(storage.fate);
  watch(t, fate, bodies);
  const orphan = await createPage(fate, { parent: newPageId() });
  await write(bodies, [orphan]);
  await delivered(fate);
  const [entry] = fate.persistence!.getSnapshot().mutations;
  assert.equal(entry?.status, "failed");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(await stored(storage.bodies, orphan), "a failed create keeps its body: the user may retry it");
  await fate.persistence!.discard(entry!.id);
  await until(allGone(storage.bodies, [orphan]), "the body to go once the create is discarded");
});

function sharedFate(): PersistenceStorage {
  const inner = memoryPagesStorage().fate;
  const listeners = new Set<() => void>();
  return {
    ...inner,
    async writeBatch(writes) {
      await inner.writeBatch(writes);
      for (const listener of listeners) listener();
    },
    subscribe(_key, listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

test("two tabs on one device both reclaim a delete one of them made", async (t) => {
  const { open } = workspace();
  const fateStorage = sharedFate();
  const bodyStorage = memoryBodies();
  const [bodiesA, bodiesB] = [openBodies({ storage: bodyStorage }), openBodies({ storage: bodyStorage })];
  t.after(() => Promise.all([bodiesA.close(), bodiesB.close()]));
  const tabA = await open(fateStorage);
  const tabB = await open(fateStorage);
  const removedByB: PageId[] = [];
  watch(t, tabA, bodiesA);
  watch(t, tabB, { ...bodiesB, remove: (id) => (removedByB.push(id), bodiesB.remove(id)) } as Bodies);

  const a = await createPage(tabA, { parent: null });
  await delivered(tabA);
  await write(bodiesA, [a]);
  const open_ = await bodiesB.open(a);
  await deletePage(tabA, a);
  await delivered(tabA);
  await until(allGone(bodyStorage, [a]), "the body to go");
  await until(() => removedByB.includes(a), "the other tab to reclaim it too");
  assert.equal(open_.save.read().state, "removed", "the other tab's open copy turned removed");
});

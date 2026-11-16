import type { StorageAdapterInterface } from "@automerge/automerge-repo";
import assert from "node:assert/strict";
import { test } from "node:test";
import { newPageId } from "../src/model/bodies.ts";
import { PagesError } from "../src/model/errors.ts";
import { MAX_TITLE } from "../src/model/list.ts";
import { openNotes } from "../src/model/notes.ts";
import { memoryStorage } from "../src/storage/memory.ts";
import { stored, tab, twoTabs, typed, until } from "./workspace.ts";

test("a new page shows at the end of its level at once", async (t) => {
  const notes = await tab(t);
  const tree = () => notes.tree.read();
  const a = notes.createPage(null);
  assert.deepEqual(tree().children(null), [a], "before any await");
  const b = notes.createPage(null);
  const a1 = notes.createPage(a);
  const a2 = notes.createPage(a);
  const c = notes.createPage(null);
  assert.deepEqual(tree().children(null), [a, b, c]);
  assert.deepEqual(tree().children(a), [a1, a2]);
  assert.deepEqual(tree().children(b), []);
  assert.deepEqual(tree().page(a1), { id: a1, parent: a, title: "" });
});

test("renames show at once, keep spaces, cap at MAX_TITLE, and merge per character across two tabs", async (t) => {
  const [A, B] = await twoTabs(t);
  const id = A.createPage(null);
  A.renamePage(id, "  Meeting ");
  assert.equal(A.tree.read().page(id)?.title, "  Meeting ", "the raw value, at once");
  A.renamePage(id, "Meeting");
  await until(() => B.tree.read().page(id)?.title === "Meeting", "B to see the rename");

  A.renamePage(id, "Meeting notes");
  B.renamePage(id, "Team Meeting");
  await until(() => A.tree.read().page(id)?.title === B.tree.read().page(id)?.title, "the titles to converge");
  assert.equal(A.tree.read().page(id)?.title, "Team Meeting notes", "both renames survive");

  A.renamePage(id, "x".repeat(MAX_TITLE + 20));
  assert.equal(A.tree.read().page(id)?.title, "x".repeat(MAX_TITLE));
});

test("a rename to the stored title, or of a page that is not there, changes nothing", async (t) => {
  const inner = memoryStorage();
  const saves: string[] = [];
  const counted: StorageAdapterInterface = { ...inner, save: (key, data) => (saves.push(key.join("/")), inner.save(key, data)) };
  const notes = await tab(t, counted);
  const id = notes.createPage(null);
  notes.renamePage(id, "Notes");
  await notes.flush();
  const before = notes.tree.read();
  let fired = 0;
  notes.tree.subscribe(() => fired++);
  saves.length = 0;

  notes.renamePage(id, "Notes");
  notes.renamePage(newPageId(), "Other");
  await notes.flush();
  assert.equal(notes.tree.read(), before, "the same tree");
  assert.equal(fired, 0, "no listener fired");
  assert.deepEqual(saves, [], "nothing was stored");
});

test("a delete takes the page and its subtree out of the tree, and a reopen shows the same tree", async () => {
  const storage = memoryStorage();
  const first = await openNotes({ storage });
  const a = first.createPage(null);
  const b = first.createPage(null);
  const a1 = first.createPage(a);
  const a11 = first.createPage(a1);
  first.renamePage(b, "Kept");
  assert.deepEqual(first.tree.read().subtree(a), [a, a1, a11]);

  first.deletePage(a);
  const tree = first.tree.read();
  assert.deepEqual(tree.children(null), [b]);
  assert.deepEqual([a, a1, a11].map((id) => tree.page(id)), [undefined, undefined, undefined]);
  assert.deepEqual(tree.subtree(a), []);
  await first.close();

  const again = await openNotes({ storage });
  try {
    assert.deepEqual(again.tree.read().children(null), [b]);
    assert.deepEqual(again.tree.read().page(b), { id: b, parent: null, title: "Kept" });
    assert.equal(again.tree.read().page(a1), undefined);
  } finally {
    await again.close();
  }
});

test("open rejects with storage when the stored list cannot be read, and seeds nothing over it", async () => {
  const inner = memoryStorage();
  const first = await openNotes({ storage: inner });
  const id = first.createPage(null);
  await first.close();

  const saves: string[] = [];
  const unreadable: StorageAdapterInterface = {
    ...inner,
    loadRange: async () => {
      throw new Error("read failed");
    },
    save: (key, data) => (saves.push(key.join("/")), inner.save(key, data)),
  };
  await assert.rejects(openNotes({ storage: unreadable }), (error) => error instanceof PagesError && error.kind === "storage");
  assert.deepEqual(saves, [], "no seed was written over the stored list");
  const again = await openNotes({ storage: inner });
  assert.deepEqual(again.tree.read().children(null), [id]);
  await again.close();
});

async function copy(from: StorageAdapterInterface): Promise<StorageAdapterInterface> {
  const to = memoryStorage();
  for (const chunk of await from.loadRange([])) await to.save(chunk.key, chunk.data!);
  return to;
}

test("a page created under a parent another tab deleted at the same time ends hidden in both, and its body is removed", async (t) => {
  const storageA = memoryStorage();
  const first = await openNotes({ storage: storageA });
  const parent = first.createPage(null);
  await first.close();
  const storageB = await copy(storageA);

  const A = await openNotes({ storage: storageA });
  const B = await openNotes({ storage: storageB });
  A.deletePage(parent);
  const child = B.createPage(parent);
  assert.ok(B.tree.read().page(child), "B shows the child while it does not know of the delete");
  const body = await B.bodies.open(child);
  body.edit(typed("written before the delete arrived"));
  await Promise.all([A.close(), B.close()]);
  assert.ok(await stored(storageB, child), "B stored the child's body");

  const [tabA, tabB] = await twoTabs(t, [storageA, storageB]);
  const later = tabB.createPage(null);
  await until(() => tabA.tree.read().page(later) !== undefined, "A to receive B's list");
  await until(() => tabB.tree.read().page(parent) === undefined, "B to receive A's delete");
  for (const notes of [tabA, tabB]) {
    assert.equal(notes.tree.read().page(child), undefined, "the child is hidden");
    assert.deepEqual(notes.tree.read().children(null), [later]);
  }
  await until(async () => !(await stored(storageB, child)), "B to remove the child's body");
});

test("two tabs that both seed the list at once merge every page", async (t) => {
  const [A, B] = await twoTabs(t);
  const fromA = [A.createPage(null), A.createPage(null)];
  const fromB = [B.createPage(null)];
  fromB.push(B.createPage(fromB[0]!));
  await until(() => A.tree.read().subtree(fromB[0]!).length === 2 && B.tree.read().page(fromA[1]!) !== undefined, "both lists to merge");
  assert.deepEqual(A.tree.read().children(null), B.tree.read().children(null));
  assert.deepEqual(new Set(A.tree.read().children(null)), new Set([...fromA, fromB[0]]));
  assert.deepEqual(A.tree.read().children(fromB[0]!), [fromB[1]]);
});

test("a title change keeps every other level and page the same object", async (t) => {
  const notes = await tab(t);
  const a = notes.createPage(null);
  const b = notes.createPage(null);
  const a1 = notes.createPage(a);
  const before = notes.tree.read();

  notes.renamePage(b, "B");
  const after = notes.tree.read();
  assert.notEqual(after, before, "a new tree");
  assert.equal(after.children(null), before.children(null), "the top level");
  assert.equal(after.children(a), before.children(a), "A's level");
  assert.equal(after.page(a), before.page(a));
  assert.equal(after.page(a1), before.page(a1));
  assert.notEqual(after.page(b), before.page(b));
  assert.equal(after.page(b)?.title, "B");

  const a2 = notes.createPage(a);
  assert.equal(notes.tree.read().children(null), after.children(null), "a create elsewhere keeps the top level");
  assert.deepEqual(notes.tree.read().children(a), [a1, a2]);
});

import type { StorageAdapterInterface } from "@automerge/automerge-repo";
import { MessageChannelNetworkAdapter } from "@automerge/automerge-repo-network-messagechannel";
import assert from "node:assert/strict";
import { test } from "node:test";
import { newPageId, openBodies } from "../src/model/bodies.ts";
import { memoryBodies } from "../src/storage/memory.ts";
import { until } from "./workspace.ts";

const typed = (text: string) => [{ type: "insert" as const, at: 1, text, marks: {} }];

test("remove of an open, edited body deletes its keys, turns it removed, and is idempotent", async (t) => {
  const storage = memoryBodies();
  const bodies = openBodies({ storage, saveDebounceMs: 1 });
  t.after(() => bodies.close());
  const id = newPageId();
  const body = await bodies.open(id);
  body.edit(typed("hello"));
  await body.flush();
  assert.ok((await storage.loadRange([id])).length > 0, "the body is stored");

  await bodies.remove(id);
  assert.deepEqual(await storage.loadRange([id]), [], "no key is left under the id");
  assert.equal(body.save.read().state, "removed");
  assert.throws(() => body.edit(typed("x")), { name: "PagesError", kind: "invalid" }, "a removed body refuses edits");
  await bodies.remove(id);
  assert.deepEqual(await storage.loadRange([id]), [], "a second remove is harmless");
});

test("remove of a closed or never-opened id resolves and leaves nothing", async (t) => {
  const storage = memoryBodies();
  const bodies = openBodies({ storage });
  t.after(() => bodies.close());
  await bodies.remove(newPageId());
  const id = newPageId();
  const body = await bodies.open(id);
  body.edit(typed("closed"));
  await body.close();
  assert.ok((await storage.loadRange([id])).length > 0, "close stored it");
  await bodies.remove(id);
  assert.deepEqual(await storage.loadRange([id]), []);
});

test("a save in flight when remove starts lands before the keys are deleted", async (t) => {
  const inner = memoryBodies();
  const id = newPageId();
  const held: (() => void)[] = [];
  const slow: StorageAdapterInterface = {
    ...inner,
    async save(key, data) {
      if (key[0] === id) await new Promise<void>((resolve) => held.push(resolve));
      await inner.save(key, data);
    },
  };
  const bodies = openBodies({ storage: slow, saveDebounceMs: 1 });
  t.after(() => bodies.close());
  const body = await bodies.open(id);
  body.edit(typed("in flight"));
  await until(() => held.length > 0, "a save of the body to start");
  const removed = bodies.remove(id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (const release of held.splice(0)) release();
  await removed;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await inner.loadRange([id]), [], "the save that was in flight did not outlive the remove");
});

test("a peer's later edits do not write a removed body back", async (t) => {
  const { port1, port2 } = new MessageChannel();
  const mine = memoryBodies();
  const A = openBodies({ storage: mine, saveDebounceMs: 1, network: [new MessageChannelNetworkAdapter(port1)] });
  const B = openBodies({ storage: memoryBodies(), saveDebounceMs: 1, network: [new MessageChannelNetworkAdapter(port2)] });
  t.after(async () => {
    await Promise.all([A.close(), B.close()]);
    port1.close();
    port2.close();
  });
  const id = newPageId();
  const [a, b] = await Promise.all([A.open(id), B.open(id)]);
  a.edit(typed("mine"));
  await until(() => b.spans().length > 1, "the peer to receive the edit");
  await A.remove(id);
  assert.deepEqual(await mine.loadRange([id]), [], "snapshot, incremental and sync-state keys are gone");
  b.edit(typed("peer"));
  await b.flush();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(await mine.loadRange([id]), [], "the peer's change was not stored here");
});

test("close then an immediate open gives a live body with the closed body's text", async (t) => {
  const bodies = openBodies({ storage: memoryBodies() });
  t.after(() => bodies.close());
  const id = newPageId();
  const first = await bodies.open(id);
  first.edit(typed("kept"));
  const closed = first.close();
  const again = await bodies.open(id);
  await closed;
  assert.notEqual(again, first, "a new body, not the closing one");
  assert.deepEqual(again.spans(), [{ type: "block", block: { type: "paragraph" } }, { type: "text", text: "kept", marks: {} }], "the text made it through the close");
  again.edit(typed("live "));
  assert.equal(again.save.read().state, "saving", "the new body takes edits");
});

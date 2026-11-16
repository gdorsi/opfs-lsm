import type { StorageAdapterInterface, StorageKey } from "@automerge/automerge-repo";
import assert from "node:assert/strict";
import { test } from "node:test";
import { saveFilter } from "../src/model/save-filter.ts";
import { memoryBodies } from "../src/storage/memory.ts";

const bytes = new Uint8Array([1]);
const chunk = (id: string, n: number): StorageKey => [id, "incremental", `h${n}`];

/** Memory storage whose saves wait until the test releases them. */
function gatedStorage(): StorageAdapterInterface & { release(): void } {
  const inner = memoryBodies();
  let open: () => void = () => {};
  let gate = new Promise<void>((resolve) => (open = resolve));
  return {
    ...inner,
    async save(key, data) {
      await gate;
      await inner.save(key, data);
    },
    release() {
      open();
      gate = Promise.resolve();
    },
  };
}

test("a blocked id gets no save after the block; other ids still save", async () => {
  const inner = memoryBodies();
  const filter = saveFilter(inner);
  await filter.save(chunk("a", 1), bytes);
  filter.block("a");
  await filter.save(chunk("a", 2), bytes);
  await filter.save(chunk("b", 1), bytes);
  assert.deepEqual((await inner.loadRange(["a"])).map((c) => c.key), [chunk("a", 1)]);
  assert.deepEqual((await inner.loadRange(["b"])).map((c) => c.key), [chunk("b", 1)]);
});

test("idle waits for a save that was already started, even across a block", async () => {
  const inner = gatedStorage();
  const filter = saveFilter(inner);
  const saving = filter.save(chunk("a", 1), bytes);
  filter.block("a");
  let idle = false;
  const waiting = filter.idle("a").then(() => (idle = true));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(idle, false, "idle must wait for the started save");
  assert.equal(await filter.idle("b").then(() => true), true, "an id with nothing in flight is idle at once");
  inner.release();
  await waiting;
  await saving;
  assert.deepEqual((await inner.loadRange(["a"])).map((c) => c.key), [chunk("a", 1)], "the started save landed");
});

test("watch reports chunk saves as they start and settle, and skips sync state", async () => {
  const inner = gatedStorage();
  const filter = saveFilter(inner);
  const events: string[] = [];
  filter.watch("a", (event) => events.push(event));
  const saving = filter.save(chunk("a", 1), bytes);
  assert.deepEqual(events, ["start"], "start is reported synchronously");
  inner.release();
  await saving;
  await filter.save(["a", "sync-state", "peer"], bytes);
  assert.deepEqual(events, ["start", "done"]);
});

test("a failed read is remembered until the next read of that id", async () => {
  let fail = true;
  const inner = memoryBodies();
  const filter = saveFilter({
    ...inner,
    async loadRange(prefix) {
      if (fail) throw new Error("disk on fire");
      return inner.loadRange(prefix);
    },
  });
  await assert.rejects(filter.loadRange(["a", "snapshot"]));
  assert.equal(filter.loadFailed("a"), true);
  assert.equal(filter.loadFailed("b"), false);
  fail = false;
  await filter.loadRange(["a", "snapshot"]);
  assert.equal(filter.loadFailed("a"), false);
});

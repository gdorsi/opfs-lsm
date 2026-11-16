import type { StorageAdapterInterface } from "@automerge/automerge-repo";
import { MessageChannelNetworkAdapter } from "@automerge/automerge-repo-network-messagechannel";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { openNotes, type Notes } from "../src/model/notes.ts";
import type { PageId, TextEdit } from "../src/model/types.ts";
import { memoryStorage } from "../src/storage/memory.ts";

/** One tab over `storage`, with no peer. */
export async function tab(t: TestContext, storage: StorageAdapterInterface = memoryStorage()): Promise<Notes> {
  const notes = await openNotes({ storage, saveDebounceMs: 1 });
  t.after(() => notes.close());
  return notes;
}

/** Two tabs linked by a MessageChannel. Pass one storage twice for two tabs of one browser. */
export async function twoTabs(
  t: TestContext,
  storage: readonly [StorageAdapterInterface, StorageAdapterInterface] = [memoryStorage(), memoryStorage()],
): Promise<[Notes, Notes]> {
  const { port1, port2 } = new MessageChannel();
  const tabs = await Promise.all([
    openNotes({ storage: storage[0], saveDebounceMs: 1, network: [new MessageChannelNetworkAdapter(port1)] }),
    openNotes({ storage: storage[1], saveDebounceMs: 1, network: [new MessageChannelNetworkAdapter(port2)] }),
  ]);
  t.after(async () => {
    await Promise.all(tabs.map((notes) => notes.close()));
    port1.close();
    port2.close();
  });
  return tabs;
}

export async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export const typed = (text: string): TextEdit[] => [{ type: "insert", at: 1, text, marks: {} }];

/** Opens each page's body, types into it and closes it, so storage holds it. */
export async function write(notes: Notes, ids: readonly PageId[]): Promise<void> {
  for (const id of ids) {
    const body = await notes.bodies.open(id);
    body.edit(typed(`body of ${id}`));
    await body.close();
  }
}

export const stored = async (storage: StorageAdapterInterface, id: PageId) => (await storage.loadRange([id])).length > 0;

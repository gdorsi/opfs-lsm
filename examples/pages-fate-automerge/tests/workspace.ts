import { createHTTPTransport } from "@nkzw/fate";
import type { PersistenceStorage } from "@nkzw/fate/persistence";
import assert from "node:assert/strict";
import { childrenRequest, createTreeClient, type Fate } from "../src/model/tree.ts";
import type { PageId } from "../src/model/types.ts";
import { openServerDb } from "../src/server/db.ts";
import { createServer } from "../src/server/fate.ts";
import { readChildren } from "../src/server/pages.ts";

/** A tree client and the server it talks to in process. `up = false` makes every request fail as an unreachable server does. */
export function workspace() {
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

export async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export const delivered = (fate: Fate) => until(() => fate.persistence!.getSnapshot().mutations.every((m) => m.status === "failed"), "the server to answer the queue");

/** The ids the device holds for `parent`'s children, or null when the level is not cached. No request. */
export async function cachedIds(fate: Fate, parent: PageId | null): Promise<PageId[] | null> {
  const observer = fate.observeRequest(childrenRequest(parent), { mode: "cache-only" });
  await until(() => observer.getSnapshot().status !== "pending", "the cache to answer");
  const snapshot = observer.getSnapshot();
  return snapshot.status === "ready" ? snapshot.data!.children.items.map((item) => item.node.id as PageId) : null;
}

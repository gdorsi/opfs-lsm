import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { BroadcastChannel as NodeChannel } from "node:worker_threads";
import { openDocStore } from "@opfs-lsm/docstore";
import type { Db } from "@opfs-lsm/kv";
import { openHarnessDb } from "@opfs-lsm/kv/testing";
import { applyLocal } from "../domain/merge.ts";
import type { StatusCode } from "../domain/model.ts";
import { memoryServer, memoryTransport } from "../server/memory.ts";
import { collections, schema, transact, type Store } from "./store.ts";
import { startSync } from "./sync.ts";

async function until(what: string, done: () => Promise<boolean> | boolean): Promise<void> {
  const end = Date.now() + 20_000;
  while (!(await done())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

// The leader listens on a BroadcastChannel it never closes, which would keep Node running after the tests.
globalThis.BroadcastChannel = class extends NodeChannel {
  constructor(name: string) {
    super(name);
    this.unref();
  }
} as unknown as typeof BroadcastChannel;

const server = memoryServer({ issues: 1000 });
let kv: Db;
let store: Store;
before(async () => {
  kv = await openHarnessDb({ name: `linearlite-sync-${process.pid}`, forceMemory: true });
  const docs = await openDocStore(kv, schema);
  store = { db: kv, docs, transport: memoryTransport(server, "ada"), ...collections(docs) };
  await store.sync.preload();
  startSync(store);
});
after(() => kv.close());

/** The replica's copy of every issue the server holds, without the sort keys only the replica stores. */
async function replicaIssues() {
  const ids = [...server.rows().issues.keys()];
  const rows = await store.docs.collection("issues").getMany(ids);
  return rows.map((r) => {
    if (!r) return r;
    const { priorityOrder: _p, statusOrder: _s, ...issue } = r;
    return issue;
  });
}
const serverIssues = () => [...server.rows().issues.values()];

async function setStatus(id: string, status: StatusCode): Promise<void> {
  const clock = Date.now();
  await transact(store, "issues", [id], ([row]) => [{ ...applyLocal(row!, { status }, clock), modified: clock }]);
}

describe("sync through memoryTransport", () => {
  it("pulls the server's 1,000 issues into an empty replica", async () => {
    await until("first sync", async () => (await store.docs.collection("issues").count({})) === 1000);
    assert.deepEqual(await replicaIssues(), serverIssues());
  });

  it("pushes a local edit, which the server then holds", async () => {
    const issue = serverIssues()[0]!;
    const status = ((issue.status + 1) % 5) as StatusCode;
    await setStatus(issue.id, status);
    await until("the edit on the server", () => server.rows().issues.get(issue.id)!.status === status);
    await until("the ack", async () => (await replicaIssues()).every((r) => r?.dirty === undefined));
    assert.deepEqual(await replicaIssues(), serverIssues());
  });

  it("keeps an edit made offline until the server is back", async () => {
    const issue = serverIssues()[1]!;
    const status = ((issue.status + 1) % 5) as StatusCode;
    server.online = false;
    await setStatus(issue.id, status);
    await new Promise((r) => setTimeout(r, 100));
    assert.notEqual(server.rows().issues.get(issue.id)!.status, status);
    server.online = true;
    await until("the edit on the server", () => server.rows().issues.get(issue.id)!.status === status);
    await until("the ack", async () => (await replicaIssues()).every((r) => r?.dirty === undefined));
    assert.deepEqual(await replicaIssues(), serverIssues());
  });

  it("pulls another user's edit", async () => {
    const issue = serverIssues()[2]!;
    server.push([{ stream: "issues", id: issue.id, fields: { title: "Renamed by grace" }, clocks: {} }], "grace");
    await until("the pull", async () => (await store.docs.collection("issues").get(issue.id))?.title === "Renamed by grace");
    assert.deepEqual(await replicaIssues(), serverIssues());
  });
});

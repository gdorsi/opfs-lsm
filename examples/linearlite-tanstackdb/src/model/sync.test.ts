import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Db } from "@opfs-lsm/kv";
import { ingest, openHarnessDb } from "@opfs-lsm/kv/testing";
import type { StatusCode } from "../domain/model.ts";
import { memoryServer, memoryTransport, type MemoryServer } from "../server/memory.ts";
import { openLinearlite, type Linearlite } from "./index.ts";
import { hold } from "./live.ts";
import { openStore, type Store } from "./store.ts";

type Replica = { readonly db: Db; readonly store: Store; readonly model: Linearlite };

async function replica(server: MemoryServer, name: string, options: { maxBytes?: number } = {}): Promise<Replica> {
  const db = await openHarnessDb({ name, forceMemory: true, ...options });
  const store = await openStore(db);
  return { db, store, model: openLinearlite({ store, transport: memoryTransport(server, "ada") }) };
}

/** Leads until the returned function is called, which resolves once the leader has stopped. */
function lead(model: Linearlite): () => Promise<void> {
  const stop = new AbortController();
  const leading = model.sync.lead(stop.signal);
  return () => {
    stop.abort();
    return leading;
  };
}

describe("sync through memoryTransport", () => {
  const server = memoryServer({ issues: 1000 });
  let r: Replica;
  let stop: () => Promise<void>;
  before(async () => {
    r = await replica(server, `linearlite-sync-${process.pid}`);
    stop = lead(r.model);
  });
  after(async () => {
    await stop();
    await r.db.close();
  });

  /** The replica's copy of every issue the server holds, without the sort keys only the replica stores. */
  async function replicaIssues() {
    const rows = await r.store.docs.collection("issues").getMany([...server.rows().issues.keys()]);
    return rows.map((row) => {
      if (!row) return row;
      const { priorityOrder: _p, statusOrder: _s, ...issue } = row;
      return issue;
    });
  }
  const serverIssues = () => [...server.rows().issues.values()];
  const next = (status: StatusCode) => ((status + 1) % 5) as StatusCode;

  it("pulls the server's 1,000 issues into an empty replica", async () => {
    await r.model.sync.settled();
    assert.deepEqual(await replicaIssues(), serverIssues());
  });

  it("pushes a local edit, which the server then holds", async () => {
    const issue = serverIssues()[0]!;
    await r.model.commands.setStatus(issue.id, next(issue.status));
    await r.model.sync.settled();
    assert.equal(server.rows().issues.get(issue.id)!.status, next(issue.status));
    assert.deepEqual(await replicaIssues(), serverIssues());
  });

  it("shows offline with the unsent edit, then idle once the server is back and has it", async () => {
    const status = hold(r.model.sync.status);
    await status.until((s) => s.kind === "idle" && s.unsynced === 0);
    const issue = serverIssues()[1]!;
    server.online = false;
    await r.model.commands.setStatus(issue.id, next(issue.status));
    await status.until((s) => s.kind === "offline" && s.unsynced === 1);
    assert.equal(server.rows().issues.get(issue.id)!.status, issue.status);
    server.online = true;
    await r.model.sync.settled();
    await status.until((s) => s.kind === "idle" && s.unsynced === 0);
    status.release();
    assert.equal(server.rows().issues.get(issue.id)!.status, next(issue.status));
    assert.deepEqual(await replicaIssues(), serverIssues());
  });

  it("pulls another user's edit", async () => {
    const issue = serverIssues()[2]!;
    server.push([{ stream: "issues", id: issue.id, fields: { title: "Renamed by grace" }, clocks: {} }], "grace");
    await r.model.sync.settled();
    assert.equal((await r.store.docs.collection("issues").get(issue.id))?.title, "Renamed by grace");
    assert.deepEqual(await replicaIssues(), serverIssues());
  });
});

describe("eviction under storage pressure", () => {
  const server = memoryServer({ issues: 300 });
  const name = `linearlite-evict-${process.pid}`;
  // Two handles on one database, as two tabs: A leads, B only shows the alert and confirms it.
  let a: Replica;
  let b: Replica;
  let stop: () => Promise<void>;
  before(async () => {
    a = await replica(server, name, { maxBytes: 64 * 1024 });
    b = await replica(server, name, { maxBytes: 64 * 1024 });
    stop = lead(a.model);
    await a.model.sync.settled();
  });
  after(async () => {
    await stop();
    await b.db.close();
    await a.db.close();
  });

  const syncRow = async (r: Replica) => (await r.store.docs.collection("sync").get("sync"))?.evict;
  const cachedBodies = async () => (await a.store.docs.collection("bodies").queryIds({})).ids.length;

  it("asks every tab through the sync row once more than 100 threads are cached, and clears them when another tab confirms", async () => {
    const ids = [...server.rows().issues.keys()].slice(0, 150);
    await a.model.sync.preload(ids);
    assert.equal(await cachedBodies(), 150);

    const pressure = hold(b.model.sync.pressure);
    await ingest(a.db);
    await pressure.until((p) => p.pending);
    assert.equal(await syncRow(b), "asked");

    await b.model.sync.confirmEviction();
    await pressure.until((p) => !p.pending);
    pressure.release();
    assert.equal(await syncRow(a), "idle");
    assert.equal(await cachedBodies(), 0);
    assert.equal((await a.store.docs.collection("issues").queryIds({})).ids.length, 300, "issues stay");
  });

  it("does not let a tab that does not lead wait for sync to settle", async () => {
    await assert.rejects(b.model.sync.settled());
  });
});

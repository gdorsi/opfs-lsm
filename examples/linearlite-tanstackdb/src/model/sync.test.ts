import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Db } from "@opfs-lsm/kv";
import { createLocalIngestClient, EngineHost, ingest, MemoryFs, openHarnessDb, type HarnessOpenOptions } from "@opfs-lsm/kv/testing";
import { openKvBackend, type KvBackend } from "../backends/kv.ts";
import type { StatusCode } from "../domain/model.ts";
import { memoryServer, memoryTransport, type MemoryServer } from "../server/memory.ts";
import { openLinearlite, type Linearlite } from "./index.ts";
import { syncView, until } from "./testing.ts";

type Replica = { readonly db: Db; readonly backend: KvBackend; readonly model: Linearlite };

async function replica(server: MemoryServer, name: string, options: Partial<HarnessOpenOptions> = {}): Promise<Replica> {
  const db = await openHarnessDb({ name, forceMemory: true, ...options });
  const backend = await openKvBackend(db);
  return { db, backend, model: openLinearlite({ backend, transport: memoryTransport(server, "ada") }) };
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
    const rows = await r.backend.docs.collection("issues").getMany([...server.rows().issues.keys()]);
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
    const view = syncView(r.model);
    await until(view.status, (s) => s.kind === "idle" && s.unsynced === 0);
    const issue = serverIssues()[1]!;
    server.online = false;
    await r.model.commands.setStatus(issue.id, next(issue.status));
    await until(view.status, (s) => s.kind === "offline" && s.unsynced === 1);
    assert.equal(server.rows().issues.get(issue.id)!.status, issue.status);
    server.online = true;
    await r.model.sync.settled();
    await until(view.status, (s) => s.kind === "idle" && s.unsynced === 0);
    view.release();
    assert.equal(server.rows().issues.get(issue.id)!.status, next(issue.status));
    assert.deepEqual(await replicaIssues(), serverIssues());
  });

  it("pulls another user's edit", async () => {
    const issue = serverIssues()[2]!;
    server.push([{ stream: "issues", id: issue.id, fields: { title: "Renamed by grace" }, clocks: {} }], "grace");
    await r.model.sync.settled();
    assert.equal((await r.backend.docs.collection("issues").get(issue.id))?.title, "Renamed by grace");
    assert.deepEqual(await replicaIssues(), serverIssues());
  });
});

/** A memory fs that refuses its next write once `refuse` is called, as a browser does at the origin's limit. */
function refusableFs(): { readonly fs: MemoryFs; refuse(): void } {
  const fs = new MemoryFs();
  const create = fs.create.bind(fs);
  let armed = false;
  fs.create = async (path) => {
    const writer = await create(path);
    return {
      ...writer,
      write: async (bytes) => {
        if (!armed) return writer.write(bytes);
        armed = false;
        throw new DOMException("the origin is full", "QuotaExceededError");
      },
    };
  };
  return { fs, refuse: () => void (armed = true) };
}

describe("eviction when the storage is full", () => {
  const server = memoryServer({ issues: 300 });
  const name = `linearlite-evict-${process.pid}`;
  const { fs, refuse } = refusableFs();
  // Two handles on one database, as two tabs: A leads, B only shows the alert and confirms it.
  let a: Replica;
  let b: Replica;
  let stop: () => Promise<void>;
  before(async () => {
    const open = { fs, ingest: createLocalIngestClient(new EngineHost(() => fs)), reserveBytes: 64 * 1024 };
    a = await replica(server, name, open);
    b = await replica(server, name, open);
    stop = lead(a.model);
    await a.model.sync.settled();
  });
  after(async () => {
    await stop();
    await b.db.close();
    await a.db.close();
  });

  const syncRow = async (r: Replica) => (await r.backend.docs.collection("sync").get("sync"))?.evict;
  const cachedBodies = async () => (await a.backend.docs.collection("bodies").queryIds({})).ids.length;

  it("asks every tab through the sync row once more than 100 threads are cached, and clears them when another tab confirms", async () => {
    const ids = [...server.rows().issues.keys()].slice(0, 150);
    await a.model.sync.preload(ids);
    assert.equal(await cachedBodies(), 150);

    const view = syncView(b.model);
    // The flush is refused once, lands on the reserve kv releases, and kv asks the leader for space.
    refuse();
    await ingest(a.db);
    await until(view.pressure, (p) => p.pending);
    assert.equal(await syncRow(b), "asked");

    await b.model.sync.confirmEviction();
    await until(view.pressure, (p) => !p.pending);
    view.release();
    assert.equal(await syncRow(a), "idle");
    assert.equal(await cachedBodies(), 0);
    assert.equal((await a.backend.docs.collection("issues").queryIds({})).ids.length, 300, "issues stay");
  });

  it("does not let a tab that does not lead wait for sync to settle", async () => {
    await assert.rejects(b.model.sync.settled());
  });
});

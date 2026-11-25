import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { createLiveQueryCollection, type InitialQueryBuilder, type QueryBuilder } from "@tanstack/db";
import type { Db } from "@opfs-lsm/kv";
import { openHarnessDb } from "@opfs-lsm/kv/testing";
import { openKvBackend } from "../backends/kv.ts";
import type { Body, Comment, Issue, PriorityCode, ServerRow } from "../domain/model.ts";
import { memoryServer, memoryTransport } from "../server/memory.ts";
import type { Backend, Unsubscribe } from "./backend.ts";
import { parseIssueFilter, type IssueFilter } from "./filter.ts";
import { openLinearlite, type Linearlite } from "./index.ts";
import { located, place, TOP, windowOf, type Placement } from "./list.ts";
import { bodyOf, commentsOf, issueById, windowQuery } from "./query.ts";
import { show, until, watched } from "./testing.ts";
import { threadOf, type Thread } from "./thread.ts";

describe("the reads", () => reads(openKvBackend));

/** What each screen reads, composed from the query builders and pure functions its hooks use. */
function reads(openBackend: (db: Db) => Promise<Backend>) {
  const server = memoryServer({ issues: 1500 });
  let db: Db;
  let backend: Backend;
  let model: Linearlite;
  const stopLeading = new AbortController();
  let leading: Promise<void>;
  const held: Unsubscribe[] = [];

  before(async () => {
    db = await openHarnessDb({ name: `linearlite-reads-${process.pid}`, forceMemory: true });
    backend = await openBackend(db);
    model = openLinearlite({ backend, transport: memoryTransport(server, "ada") });
    leading = model.sync.lead(stopLeading.signal);
    await model.sync.settled();
  });
  after(async () => {
    for (const release of held) release();
    stopLeading.abort();
    await leading;
    await backend.close();
    await db.close();
  });

  /** Subscribed until the suite ends, as a screen that shows it. */
  const keep = <T extends { release: Unsubscribe }>(subscribed: T): T => (held.push(subscribed.release), subscribed);
  const live = <R,>(query: (q: InitialQueryBuilder) => QueryBuilder<any>) => keep(show<R>(createLiveQueryCollection({ query, gcTime: 1 })));

  /** Waits up to `ms` for `read()` to equal `want`, then asserts that it does. */
  async function shows<P>(read: () => P, want: P, ms = 5000): Promise<void> {
    await until(read, (v) => isDeepStrictEqual(v, want), ms).catch(() => undefined);
    assert.deepEqual(read(), want);
  }

  type Row = ServerRow<"issues">;
  const all = () => [...server.rows().issues.values()].filter((i) => !i.deleted);
  const ids = (rows: readonly { readonly id: string }[]) => rows.map((r) => r.id);
  const desc = (a: number, b: number) => b - a;
  const byModified = (a: Row, b: Row) => desc(a.modified, b.modified);
  const byPriority = (a: Row, b: Row) => desc(a.priority, b.priority) || desc(a.status, b.status) || byModified(a, b);
  const byBoardOrder = (a: Row, b: Row) => (a.kanbanorder < b.kanbanorder ? -1 : 1);
  /** `row`'s fields that `like` has, so a replica's row compares with the server's. */
  const fieldsOf = (row: object | undefined, like: object) => row && Object.fromEntries(Object.keys(like).map((k) => [k, (row as Record<string, unknown>)[k]]));

  /** Where `setRange(from, to)` places the list, as `useIssueList` does: `place`, then `locate` when it asks to. */
  async function placed(filter: IssueFilter, from: number, to: number, current: Placement = TOP, base = 0): Promise<Placement> {
    const anchoring = model.index.anchor(filter);
    const step = place(current, from, to, { canAnchor: anchoring !== undefined, base });
    return step.kind === "placed" ? step.placement : located(current, step, await anchoring!.locate(step.row));
  }

  /** The list at `placement` as `useIssueList` shows it: its rows, and the row of the list the first one is. */
  function listAt(filter: IssueFilter, placement: Placement) {
    const rows = keep(show<Issue[]>(windowQuery(model.collections.issues, filter, windowOf(placement))));
    const { anchor } = placement;
    const base = anchor && keep(watched<number>((emit) => model.index.anchor(filter)!.watchBase(anchor.value, emit)));
    return {
      rows,
      read: () => ({ ids: ids(rows.read().data), offset: (anchor ? (base!.read() ?? anchor.base) : 0) + placement.offset }),
    };
  }

  describe("the issue list", () => {
    it("shows the newest issues first, and their total", async () => {
      const filter = parseIssueFilter({});
      const list = listAt(filter, TOP);
      const total = keep(watched<number>((emit) => model.index.watchTotal(filter, emit)));
      await shows(() => ({ ...list.read(), total: total.read() }), {
        ids: ids(all().sort(byModified).slice(0, 100)),
        offset: 0,
        total: all().length,
      });
    });

    it("shows two statuses by priority, and moves its window down", async () => {
      const want = all()
        .filter((i) => i.status === 1 || i.status === 3)
        .sort(byPriority);
      const filter = parseIssueFilter({ status: "1,3", sort: "priority", dir: "desc" });
      const list = listAt(filter, TOP);
      const total = keep(watched<number>((emit) => model.index.watchTotal(filter, emit)));
      await shows(() => ({ ...list.read(), total: total.read() }), { ids: ids(want.slice(0, 100)), offset: 0, total: want.length });

      const next = await placed(filter, 100, 200);
      assert.equal(next.anchor, undefined, "a filtered list stays one query from the top");
      await list.rows.collection.utils.setWindow(windowOf(next));
      await shows(() => ids(list.rows.read().data), ids(want.slice(100, 200)));
    });

    it("shows a window deep in the list, and after another user's edit moves a row above it, its rows one lower", async () => {
      const filter = parseIssueFilter({});
      const placement = await placed(filter, 1100, 1200);
      assert.ok(placement.anchor, "a window past the first 1,000 rows starts at an anchor");
      const list = listAt(filter, placement);
      await shows(list.read, { ids: ids(all().sort(byModified).slice(1100, 1200)), offset: 1100 });

      // The server stamps `modified` on an edit, so the issue below the window moves to the top of the list.
      const below = all().sort(byModified)[1300]!;
      server.push([{ stream: "issues", id: below.id, fields: { priority: ((below.priority + 1) % 5) as PriorityCode }, clocks: {} }], "grace");
      await model.sync.settled();
      const want = all().sort(byModified);
      assert.equal(want[0]!.id, below.id);
      const at = 1101;
      await shows(list.read, { ids: ids(want.slice(at, at + 100)), offset: at });
    });
  });

  describe("a board column", () => {
    it("shows one status in board order, and grows a page at a time", async () => {
      const want = all()
        .filter((i) => i.status === 2)
        .sort(byBoardOrder);
      const column = keep(show<Issue[]>(windowQuery(model.collections.issues, parseIssueFilter({}), { offset: 0, limit: 50 }, 2)));
      await shows(() => ids(column.read().data), ids(want.slice(0, 50)));
      await column.collection.utils.setWindow({ offset: 0, limit: 100 });
      await shows(() => ids(column.read().data), ids(want.slice(0, 100)));
    });

    it("counts the issues of each status", async () => {
      const want = [0, 1, 2, 3, 4].map((s) => all().filter((i) => i.status === s).length);
      const counts = keep(watched<readonly number[]>((emit) => model.index.watchCounts(parseIssueFilter({}), emit)));
      await shows(counts.read, want);
    });
  });

  describe("an issue's page", () => {
    const thread = (id: string) => {
      const comments = [...server.rows().comments.values()].filter((c) => c.issue_id === id && !c.deleted).sort((a, b) => a.created - b.created);
      return { description: server.rows().bodies.get(id)!.description, comments: ids(comments) };
    };
    const project = (t: Thread) => (t.kind === "ready" ? { description: t.body.description, comments: ids(t.comments) } : t.kind);

    /** The thread as `useIssueThread` reads it: it fetches from the server while the replica has no body. */
    function threadView(id: string): () => Thread {
      const body = live<Body | undefined>(bodyOf(model.collections.bodies, id));
      const comments = live<Comment[]>(commentsOf(model.collections.comments, id));
      let answered = false;
      let fetching: Unsubscribe | undefined;
      held.push(() => fetching?.());
      return () => {
        const b = body.read();
        if (b.isReady && b.data === undefined) fetching ??= model.sync.loadThread(id, () => (answered = true));
        return threadOf(b, comments.read(), answered);
      };
    }

    it("shows the issue as the server holds it", async () => {
      const issue = all()[0]!;
      const row = live<Issue | undefined>(issueById(model.collections.issues, issue.id));
      await shows(() => fieldsOf(row.read().data ?? model.collections.issues.get(issue.id), issue), { ...issue });
    });

    it("fetches a thread the replica lacks", async () => {
      const issue = all()[10]!;
      const view = threadView(issue.id);
      await shows(() => project(view()), thread(issue.id));
    });

    it("fetches a thread again as soon as the network comes back", async () => {
      const issue = all()[11]!;
      server.online = false;
      const view = threadView(issue.id);
      const offline = Date.now() + 50;
      await until(view, () => Date.now() > offline);
      assert.equal(view().kind, "loading");
      server.online = true;
      // Well inside the 1 s backoff after the failed fetch.
      await shows(() => project(view()), thread(issue.id), 500);
    });

    it("shows a preloaded thread with the server offline", async () => {
      const issue = all()[12]!;
      await model.sync.preload([issue.id]);
      server.online = false;
      try {
        const view = threadView(issue.id);
        await shows(() => project(view()), thread(issue.id), 500);
      } finally {
        server.online = true;
      }
    });
  });
}

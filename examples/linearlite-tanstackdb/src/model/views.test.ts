import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { isDeepStrictEqual } from "node:util";
import type { Db } from "@opfs-lsm/kv";
import { openHarnessDb } from "@opfs-lsm/kv/testing";
import type { PriorityCode, ServerRow } from "../domain/model.ts";
import { memoryServer, memoryTransport } from "../server/memory.ts";
import { parseIssueFilter } from "./filter.ts";
import { openLinearlite, type Linearlite } from "./index.ts";
import { hold, type Held, type Live } from "./live.ts";
import { openStore } from "./store.ts";
import type { Thread } from "./views.ts";

const server = memoryServer({ issues: 1500 });
let db: Db;
let model: Linearlite;
const stopLeading = new AbortController();
let leading: Promise<void>;
const shown: Held<unknown>[] = [];

before(async () => {
  db = await openHarnessDb({ name: `linearlite-views-${process.pid}`, forceMemory: true });
  model = openLinearlite({ store: await openStore(db), transport: memoryTransport(server, "ada") });
  leading = model.sync.lead(stopLeading.signal);
  await model.sync.settled();
});
after(async () => {
  for (const view of shown) view.release();
  stopLeading.abort();
  await leading;
  await db.close();
});

/** Subscribed until the file ends, as a screen that shows it. */
function show<T>(live: Live<T>): Held<T> {
  const view = hold(live);
  shown.push(view as Held<unknown>);
  return view;
}

/** Waits up to `ms` for `project` of the view's value to equal `want`, then asserts that it does. */
async function shows<T, P>(view: Held<T>, project: (value: T) => P, want: P, ms = 5000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([view.until((v) => isDeepStrictEqual(project(v), want)), new Promise((resolve) => (timer = setTimeout(resolve, ms)))]);
  clearTimeout(timer);
  assert.deepEqual(project(view.get()), want);
}

type Row = ServerRow<"issues">;
const live = () => [...server.rows().issues.values()].filter((i) => !i.deleted);
const ids = (rows: readonly { readonly id: string }[]) => rows.map((r) => r.id);
const desc = (a: number, b: number) => b - a;
const byModified = (a: Row, b: Row) => desc(a.modified, b.modified);
const byPriority = (a: Row, b: Row) => desc(a.priority, b.priority) || desc(a.status, b.status) || byModified(a, b);
const byBoardOrder = (a: Row, b: Row) => (a.kanbanorder < b.kanbanorder ? -1 : 1);
/** `row`'s fields that `like` has, so a replica's row compares with the server's. */
const fieldsOf = (row: object | undefined, like: object) => row && Object.fromEntries(Object.keys(like).map((k) => [k, (row as Record<string, unknown>)[k]]));
const windowOf = (v: { rows: readonly { id: string }[]; offset: number }) => ({ ids: ids(v.rows), offset: v.offset });

describe("the issue list", () => {
  it("shows the newest issues first, and their total", async () => {
    const view = show(model.issues.list(parseIssueFilter({})));
    await shows(view, (v) => ({ ...windowOf(v), total: v.total }), {
      ids: ids(live().sort(byModified).slice(0, 100)),
      offset: 0,
      total: live().length,
    });
  });

  it("shows two statuses by priority, and moves its window down", async () => {
    const want = live()
      .filter((i) => i.status === 1 || i.status === 3)
      .sort(byPriority);
    const list = model.issues.list(parseIssueFilter({ status: "1,3", sort: "priority", dir: "desc" }));
    const view = show(list);
    await shows(view, (v) => ({ ...windowOf(v), total: v.total }), { ids: ids(want.slice(0, 100)), offset: 0, total: want.length });
    list.setRange(100, 200);
    await shows(view, windowOf, { ids: ids(want.slice(100, 200)), offset: 100 });
  });

  it("shows a window deep in the list, and shows its rows one lower when another user's edit moves a row above them", async () => {
    const list = model.issues.list(parseIssueFilter({}));
    const view = show(list);
    list.setRange(1100, 1200);
    await shows(view, windowOf, { ids: ids(live().sort(byModified).slice(1100, 1200)), offset: 1100 });

    // The server stamps `modified` on an edit, so the issue below the window moves to the top of the list.
    const below = live().sort(byModified)[1300]!;
    server.push([{ stream: "issues", id: below.id, fields: { priority: ((below.priority + 1) % 5) as PriorityCode }, clocks: {} }], "grace");
    await model.sync.settled();
    const want = live().sort(byModified);
    assert.equal(want[0]!.id, below.id);
    await shows(view, windowOf, { ids: ids(want.slice(1101, 1201)), offset: 1101 });
  });
});

describe("a board column", () => {
  it("shows one status in board order, and moves its window down", async () => {
    const want = live()
      .filter((i) => i.status === 2)
      .sort(byBoardOrder);
    const column = model.issues.column(parseIssueFilter({}), 2);
    const view = show(column);
    await shows(view, windowOf, { ids: ids(want.slice(0, 50)), offset: 0 });
    column.setRange(50, 150);
    await shows(view, windowOf, { ids: ids(want.slice(50, 150)), offset: 50 });
  });

  it("counts the issues of each status", async () => {
    const want = [0, 1, 2, 3, 4].map((s) => live().filter((i) => i.status === s).length);
    await shows(show(model.issues.counts(parseIssueFilter({}))), (v) => v, want);
  });
});

describe("an issue's page", () => {
  const thread = (id: string) => {
    const comments = [...server.rows().comments.values()].filter((c) => c.issue_id === id && !c.deleted).sort((a, b) => a.created - b.created);
    return { description: server.rows().bodies.get(id)!.description, comments: ids(comments) };
  };
  const project = (t: Thread) =>
    t.kind === "ready" ? { description: t.body.description, comments: ids(t.comments) } : t.kind;

  it("shows the issue as the server holds it", async () => {
    const issue = live()[0]!;
    await shows(show(model.issues.get(issue.id)), (row) => fieldsOf(row, issue), { ...issue });
  });

  it("fetches a thread the replica lacks", async () => {
    const issue = live()[10]!;
    await shows(show(model.issues.thread(issue.id)), project, thread(issue.id));
  });

  it("fetches a thread again as soon as the network comes back", async () => {
    const issue = live()[11]!;
    server.online = false;
    const view = show(model.issues.thread(issue.id));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(view.get().kind, "loading");
    server.online = true;
    // Well inside the 1 s backoff after the failed fetch.
    await shows(view, project, thread(issue.id), 500);
  });

  it("shows a preloaded thread with the server offline", async () => {
    const issue = live()[12]!;
    await model.sync.preload([issue.id]);
    server.online = false;
    try {
      await shows(show(model.issues.thread(issue.id)), project, thread(issue.id), 500);
    } finally {
      server.online = true;
    }
  });
});

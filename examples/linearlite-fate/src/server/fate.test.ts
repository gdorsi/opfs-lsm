import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { generate, type SeedIssue } from "../../scripts/generate.ts";
import { SORT_FIELDS, type SortField } from "../client/filter.ts";
import { PERSISTENCE_KEY, PRIORITIES, STATUSES, type FilterArgs, type WindowArgs } from "../domain/model.ts";
import { openServerDb } from "./db.ts";
import { createServer } from "./fate.ts";
import { windowSql } from "./issues.ts";
import { seedDb } from "./seed.ts";

const COUNT = 400;
const seed = generate(COUNT);
const issues = seed.issues.map((s) => ({ ...s, status: STATUSES.indexOf(s.status), priority: PRIORITIES.indexOf(s.priority) }));
type Expected = (typeof issues)[number];

/** The list order from the requirement: the sort's fields, then id, all in one direction. */
const KEYS: Record<SortField, (i: Expected) => readonly (number | string)[]> = {
  modified: (i) => [i.modified, i.id],
  created: (i) => [i.created, i.id],
  title: (i) => [i.title, i.id],
  priority: (i) => [i.priority, i.status, i.modified, i.id],
  status: (i) => [i.status, i.kanbanorder, i.id],
};
function expectedIds(args: WindowArgs): string[] {
  const keyOf = KEYS[args.sort];
  const cmp = (a: Expected, b: Expected) => {
    const [x, y] = [keyOf(a), keyOf(b)];
    for (let k = 0; k < x.length; k++) if (x[k] !== y[k]) return (x[k]! < y[k]! ? -1 : 1) * (args.dir === "asc" ? 1 : -1);
    return 0;
  };
  return issues
    .filter((i) => (args.status.length === 0 || args.status.includes(i.status as never)) && (args.priority.length === 0 || args.priority.includes(i.priority as never)))
    .filter((i) => i.title.toLowerCase().includes(args.q.toLowerCase()))
    .sort(cmp)
    .slice(args.offset, args.offset + args.limit)
    .map((i) => i.id);
}

let dir: string;
let db: DatabaseSync;
let server: ReturnType<typeof createServer>;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "linearlite-fate-"));
  db = openServerDb(join(dir, "test.db"));
  seedDb(db, COUNT);
  server = createServer(db);
});
after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

type Op = Record<string, unknown>;
type Result = { ok: boolean; data?: any; error?: { code: string } };

async function call(operations: Op[], user = "tester"): Promise<Result[]> {
  const version = operations.some((op) => op.mutation) ? 3 : 1;
  const response = await server.handleRequest(
    new Request("http://local/api/fate", {
      method: "POST",
      headers: { "content-type": "application/json", "x-linearlite-user": user },
      body: JSON.stringify({ operations: operations.map((op, i) => ({ id: String(i + 1), select: [], ...op })), version }),
    }),
  );
  return ((await response.json()) as { results: Result[] }).results;
}
const one = async (op: Op, user?: string) => (await call([op], user))[0]!;

const window = (args: Partial<WindowArgs>): WindowArgs => ({ status: [], priority: [], q: "", sort: "modified", dir: "desc", offset: 0, limit: 25, ...args });
const listIds = async (args: WindowArgs) => {
  const r = await one({ kind: "list", name: "issues", args, select: ["id", "title"] });
  assert.ok(r.ok, JSON.stringify(r.error));
  return (r.data.items as { node: { id: string } }[]).map((item) => item.node.id);
};

let identities = 0;
const identity = () => {
  const now = Date.now();
  const uuid = `00000000-0000-4000-8000-${String(++identities).padStart(12, "0")}`;
  return { id: `fate:1:${now}:${now + 86_400_000}:${uuid}`, scope: PERSISTENCE_KEY };
};
const mutate = (name: string, input: unknown, select: string[] = ["id"], mutation = identity(), user?: string) =>
  one({ kind: "mutation", name, input, select, mutation }, user);

describe("fate server", () => {
  it("serves each sort in both directions, a window deep in the list and the last partial window", async () => {
    for (const sort of SORT_FIELDS) {
      for (const d of ["asc", "desc"] as const) {
        for (const offset of [0, 180, 390]) {
          const args = window({ sort, dir: d, offset });
          assert.deepEqual(await listIds(args), expectedIds(args), `${sort} ${d} from ${offset}`);
        }
      }
    }
  });

  it("filters by status, priority and title text, case-insensitively and with % and _ taken literally", async () => {
    const cases = [
      window({ status: [1, 3] }),
      window({ priority: [0], offset: 30 }),
      window({ status: [2], priority: [1, 4], sort: "title", dir: "asc" }),
      window({ q: "SYNC" }),
      window({ q: "sync cache" }),
      window({ q: "%" }),
      window({ q: "s_nc" }),
    ];
    for (const args of cases) assert.deepEqual(await listIds(args), expectedIds(args), JSON.stringify(args));
    assert.ok(expectedIds(window({ q: "SYNC" })).length > 0, "the search case matches something");
  });

  it("never reports rows before a window, which fate reads as the list not being cached", async () => {
    const r = await one({ kind: "list", name: "issues", args: window({ offset: 50 }), select: ["id"] });
    assert.equal(r.data.pagination.hasPrevious, false);
  });

  it("counts the issues under a filter per status", async () => {
    const filters: FilterArgs[] = [{ status: [], priority: [], q: "" }, { status: [0, 4], priority: [2], q: "" }, { status: [], priority: [], q: "offline" }];
    for (const filter of filters) {
      const r = await one({ kind: "query", name: "counts", args: filter });
      const all = expectedIds(window({ ...filter, limit: COUNT }));
      const expected = [0, 1, 2, 3, 4].map((s) => issues.filter((i) => all.includes(i.id) && i.status === s).length);
      assert.deepEqual(r.data, expected, JSON.stringify(filter));
    }
  });

  it("pages a board column by kanbanorder with cursors, without gaps or repeats", async () => {
    const column = issues.filter((i) => i.status === 2).sort((a, b) => (a.kanbanorder < b.kanbanorder ? -1 : 1));
    const seen: string[] = [];
    let after: string | undefined;
    for (;;) {
      const r = await one({ kind: "list", name: "column", args: { column: 2, priority: [], q: "", first: 30, ...(after && { after }) }, select: ["id"] });
      seen.push(...r.data.items.map((item: { node: { id: string } }) => item.node.id));
      if (!r.data.pagination.hasNext) break;
      after = r.data.pagination.nextCursor;
    }
    assert.deepEqual(seen, column.map((i) => i.id));
  });

  it("returns an issue's description and its comments oldest first", async () => {
    const withComments = Map.groupBy(seed.comments, (c) => c.issue_id);
    const issue = seed.issues.find((i) => withComments.has(i.id)) as SeedIssue;
    const r = await one({ kind: "byId", type: "Issue", ids: [issue.id], select: ["id", "title", "description", "comments.id", "comments.body", "comments.created"] });
    const [got] = r.data;
    assert.equal(got.description, issue.description);
    const expected = withComments.get(issue.id)!.toSorted((a, b) => a.created - b.created).map((c) => ({ id: c.id, body: c.body, created: c.created }));
    assert.deepEqual(got.comments.items.map((item: { node: unknown }) => item.node), expected);
  });

  it("applies each mutation to the database", async () => {
    const [target] = await listIds(window({}));
    const update = await mutate("updateIssue", { id: target, title: "Renamed", status: 4, description: "New text" }, ["id", "title", "status", "modified"]);
    assert.ok(update.ok, JSON.stringify(update.error));
    const row = db.prepare("SELECT title, status, description, modified FROM issue WHERE id = ?").get(target!)!;
    assert.deepEqual({ title: row.title, status: row.status, description: row.description }, { title: "Renamed", status: 4, description: "New text" });
    assert.equal(update.data.modified, row.modified);

    const id = crypto.randomUUID();
    const created = await mutate("createIssue", { id, title: "Fresh", description: "Body", status: 1, priority: 0, kanbanorder: "a0" }, ["id", "username"], identity(), "ada");
    assert.ok(created.ok, JSON.stringify(created.error));
    assert.equal(created.data.username, "ada");
    assert.equal(db.prepare("SELECT username FROM issue WHERE id = ?").get(id)!.username, "ada");

    const comment = await mutate("addComment", { id: crypto.randomUUID(), issueId: id, body: "First" }, ["id", "body", "username"], identity(), "grace");
    assert.ok(comment.ok, JSON.stringify(comment.error));
    assert.deepEqual({ body: comment.data.body, username: comment.data.username }, { body: "First", username: "grace" });

    assert.ok((await mutate("deleteIssue", { id })).ok);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM issue WHERE id = ?").get(id)!.n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM comment WHERE issue_id = ?").get(id)!.n, 0, "the issue's comments go with it");
  });

  it("refuses a kanbanorder that is not a fractional index, so later creates in the column still get one", async () => {
    const [target] = await listIds(window({}));
    for (const kanbanorder of ["!", "a!", "a00"]) {
      const created = await mutate("createIssue", { id: crypto.randomUUID(), title: "Bad order", description: "", status: 3, priority: 0, kanbanorder });
      assert.equal(created.error?.code, "VALIDATION_ERROR", kanbanorder);
      assert.equal((await mutate("updateIssue", { id: target, kanbanorder })).error?.code, "VALIDATION_ERROR", kanbanorder);
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM issue WHERE title = 'Bad order'").get()!.n, 0);
    const next = await mutate("createIssue", { id: crypto.randomUUID(), title: "Server picks", description: "", status: 3, priority: 0 }, ["id", "kanbanorder"]);
    assert.ok(next.ok, JSON.stringify(next.error));
    const top = db.prepare("SELECT MIN(kanbanorder) AS top FROM issue WHERE status = 3").get()!.top;
    assert.equal(next.data.kanbanorder, top);
  });

  it("refuses an edit of a missing issue and a malformed list request", async () => {
    assert.equal((await mutate("updateIssue", { id: "nope", title: "x" })).error?.code, "NOT_FOUND");
    assert.equal((await one({ kind: "list", name: "issues", args: { ...window({}), sort: "version" } })).error?.code, "BAD_REQUEST");
  });

  it("applies a replayed durable mutation once and answers the replay with the first result", async () => {
    const issueId = (await listIds(window({})))[1]!;
    const before = db.prepare("SELECT COUNT(*) AS n FROM comment WHERE issue_id = ?").get(issueId)!.n as number;
    const input = { id: crypto.randomUUID(), issueId, body: "Once" };
    const mutation = identity();
    const first = await mutate("addComment", input, ["id", "body"], mutation);
    const replay = await mutate("addComment", input, ["id", "body"], mutation);
    assert.ok(first.ok && replay.ok, JSON.stringify([first.error, replay.error]));
    assert.deepEqual(replay.data, first.data);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM comment WHERE issue_id = ?").get(issueId)!.n, before + 1);
    assert.equal((await mutate("addComment", { ...input, body: "Changed" }, ["id", "body"], mutation)).error?.code, "BAD_REQUEST", "same identity, other input");
  });

  it("runs two durable mutations sent in one batch, each in its own transaction", async () => {
    const [a, b] = await listIds(window({ offset: 10 }));
    const results = await call([
      { kind: "mutation", name: "updateIssue", input: { id: a, priority: 0 }, select: ["id"], mutation: identity() },
      { kind: "mutation", name: "updateIssue", input: { id: b, priority: 0 }, select: ["id"], mutation: identity() },
    ]);
    assert.deepEqual(results.map((r) => r.ok), [true, true]);
    assert.deepEqual(db.prepare("SELECT priority FROM issue WHERE id IN (?, ?)").all(a!, b!).map((r) => r.priority), [0, 0]);
  });

  it("reads every filtered window from its sort's index, with no sort step", () => {
    for (const sort of SORT_FIELDS) {
      const { sql, params } = windowSql(window({ sort, status: [1, 2], q: "x" }));
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((r) => r.detail as string);
      assert.equal(plan.length, 1, `${sort}: no temporary sort step: ${plan.join(" | ")}`);
      assert.match(plan[0]!, new RegExp(`^(SCAN|SEARCH) issue USING INDEX issue_by_${sort}\\b`), sort);
    }
  });
});

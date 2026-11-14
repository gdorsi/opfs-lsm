import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ServerRow } from "../domain/model.ts";
import { parseIssueFilter } from "../model/filter.ts";
import type { ServerRows } from "../server/memory.ts";
import { reference } from "./reference.ts";

const issue = (id: string, o: Partial<ServerRow<"issues">>): ServerRow<"issues"> => ({
  id,
  title: id,
  status: 0,
  priority: 0,
  kanbanorder: id,
  username: "ada",
  created: 0,
  modified: 0,
  deleted: false,
  version: 1,
  ...o,
});

const issues = [
  issue("a", { title: "Fix the cache", status: 1, priority: 2, modified: 40, created: 5, kanbanorder: "a2" }),
  issue("b", { title: "Add Cache layer", status: 1, priority: 0, modified: 30, created: 4, kanbanorder: "a1" }),
  issue("c", { title: "Remove sync", status: 3, priority: 0, modified: 20, created: 3, kanbanorder: "a0" }),
  issue("d", { title: "Cache gone", status: 1, priority: 1, modified: 10, created: 2, deleted: true }),
  issue("e", { title: "Profile", status: 4, priority: 1, modified: 50, created: 1, kanbanorder: "a3" }),
];
const comment = (id: string, created: number, deleted = false): ServerRow<"comments"> => ({
  key: `a:${id}`,
  id,
  issue_id: "a",
  body: id,
  username: "ada",
  created,
  deleted,
  version: 1,
});
const rows: ServerRows = {
  issues: new Map(issues.map((i) => [i.id, i])),
  bodies: new Map([["a", { id: "a", description: "text", version: 1 }]]),
  comments: new Map([comment("x", 2), comment("y", 1), comment("z", 3, true)].map((c) => [c.id, c])),
};
const filter = (search: Record<string, unknown> = {}) => parseIssueFilter(search);
const ref = reference(rows);
const ids = (xs: readonly { id: string }[]) => xs.map((i) => i.id).join("");

describe("the reference", () => {
  it("lists live issues, newest modified first by default and oldest first when ascending", () => {
    assert.equal(ids(ref.list(filter())), "eabc");
    assert.equal(ids(ref.list(filter({ dir: "asc" }))), "cbae");
  });

  it("orders by priority, then status, then modified", () => {
    assert.equal(ids(ref.list(filter({ sort: "priority", dir: "asc" }))), "bcea");
  });

  it("keeps the statuses and priorities asked for, and titles that hold the query in any case", () => {
    assert.equal(ids(ref.list(filter({ status: "1" }))), "ab");
    assert.equal(ids(ref.list(filter({ status: "1", priority: "2" }))), "a");
    assert.equal(ids(ref.list(filter({ q: "CACHE" }))), "ab");
  });

  it("counts per status, leaving out the statuses the filter excludes, and totals them", () => {
    assert.deepEqual(ref.counts(filter()), [0, 2, 0, 1, 1]);
    assert.deepEqual(ref.counts(filter({ status: "1,3" })), [0, 2, 0, 1, 0]);
    assert.equal(ref.total(filter({ q: "cache" })), 2);
  });

  it("orders a board column by kanban order, whatever the status filter says", () => {
    const got = [issues[1]!, issues[0]!];
    assert.equal(ref.column(filter({ status: "3" }), 1, 0, 50, got), undefined);
    assert.match(ref.column(filter(), 1, 0, 50, [...got].reverse()) ?? "", /sorts away/);
  });

  it("accepts a window of the server's rows and names the first row that differs", () => {
    const want = ref.list(filter());
    assert.equal(ref.window(filter(), 0, 100, want), undefined);
    assert.equal(ref.window(filter(), 1, 2, want.slice(1, 3)), undefined);
    assert.match(ref.window(filter(), 1, 2, want.slice(0, 2)) ?? "", /row 1 is e, which sorts away from the server's a/);
    assert.match(ref.window(filter(), 0, 100, want.slice(1)) ?? "", /3 rows from row 0, the server has 4/);
    assert.match(ref.window(filter(), 0, 2, [want[0]!, { ...want[1]!, title: "other" }]) ?? "", /title is "other"/);
    assert.match(ref.window(filter(), 0, 2, [want[0]!, want[0]!]) ?? "", /listed twice/);
  });

  it("accepts a thread with its live comments oldest first", () => {
    const comments = [rows.comments.get("y")!, rows.comments.get("x")!];
    assert.equal(ref.sameThread("a", { description: "text", comments }), undefined);
    assert.match(ref.sameThread("a", { description: "text", comments: [...comments].reverse() }) ?? "", /sorts away/);
    assert.match(ref.sameThread("a", { description: "text", comments: [...comments, rows.comments.get("z")!] }) ?? "", /3 comments/);
    assert.match(ref.sameThread("b", { description: "text", comments: [] }) ?? "", /description of b/);
  });

  it("compares a replica row with the server's", () => {
    assert.equal(ref.row("issues", "a", issues[0]), undefined);
    assert.match(ref.row("issues", "a", { ...issues[0]!, status: 2 }) ?? "", /status is 2/);
    assert.match(ref.row("issues", "a", undefined) ?? "", /missing/);
    assert.match(ref.row("issues", "nope", issues[0]) ?? "", /not on the server/);
  });
});

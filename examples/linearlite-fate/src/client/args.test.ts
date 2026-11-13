import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { columnArgs, filterArgs, LIST_WINDOW, matches, windowArgs } from "./args.ts";
import { parseIssueFilter } from "./filter.ts";

const all = parseIssueFilter({});

describe("windowArgs", () => {
  it("aligns the offset down to a step of 50 and covers the requested rows", () => {
    for (const start of [0, 1, 49, 50, 99, 4999, 5000, 5049]) {
      const { offset, limit } = windowArgs(all, start);
      assert.equal(offset % 50, 0);
      assert.ok(offset <= start && start + LIST_WINDOW <= offset + limit, `start ${start}`);
    }
    assert.equal(windowArgs(all, 4999).offset, 4950);
    assert.equal(windowArgs(all, -3).offset, 0);
  });

  it("gives nearby starts the same args, so they share one cache entry", () => {
    assert.deepEqual(windowArgs(all, 5000), windowArgs(all, 5049));
    assert.notDeepEqual(windowArgs(all, 5000), windowArgs(all, 5050));
  });

  it("carries the filter and the sort", () => {
    const filter = parseIssueFilter({ status: "1", priority: "0,2", q: "sync", sort: "title", dir: "asc" });
    assert.deepEqual(windowArgs(filter, 0), { status: [1], priority: [0, 2], q: "sync", sort: "title", dir: "asc", offset: 0, limit: LIST_WINDOW + 50 });
  });
});

describe("filterArgs", () => {
  it("drops the sort, so a sort change keeps the counts", () => {
    assert.deepEqual(filterArgs(parseIssueFilter({ status: "2", sort: "title" })), filterArgs(parseIssueFilter({ status: "2", sort: "created" })));
  });
});

describe("columnArgs", () => {
  it("lists every column without a status filter", () => {
    assert.deepEqual(columnArgs(3, parseIssueFilter({ priority: "1", q: "x" }), 50), { column: 3, priority: [1], q: "x", first: 50 });
  });

  it("leaves out a column the status filter excludes", () => {
    const filter = parseIssueFilter({ status: "1,2" });
    assert.equal(columnArgs(0, filter, 50), undefined);
    assert.ok(columnArgs(2, filter, 50));
  });
});

describe("matches", () => {
  const issue = { status: 1, priority: 2, title: "Fix Sync on reload" } as const;

  it("checks status, priority and title like the server", () => {
    assert.ok(matches(filterArgs(all), issue));
    assert.ok(matches({ status: [1], priority: [2], q: "sync ON" }, issue));
    assert.ok(!matches({ status: [0], priority: [], q: "" }, issue));
    assert.ok(!matches({ status: [], priority: [3], q: "" }, issue));
    assert.ok(!matches({ status: [], priority: [], q: "offline" }, issue));
  });

  it("folds only ASCII case, as SQLite LIKE does", () => {
    assert.ok(!matches({ status: [], priority: [], q: "ü" }, { ...issue, title: "Über" }));
    assert.ok(matches({ status: [], priority: [], q: "Ü" }, { ...issue, title: "Über" }));
  });
});

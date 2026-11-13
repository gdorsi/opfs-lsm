import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseIssueFilter } from "./filter.ts";

describe("parseIssueFilter", () => {
  it("defaults to every issue, most recently modified first", () => {
    assert.deepEqual(parseIssueFilter({}), { status: [], priority: [], q: "", sort: "modified", dir: "desc" });
  });

  it("reads codes as a comma list, a single number or an array, sorted and deduplicated", () => {
    assert.deepEqual(parseIssueFilter({ status: "2,1,2" }).status, [1, 2]);
    assert.deepEqual(parseIssueFilter({ status: 3 }).status, [3]);
    assert.deepEqual(parseIssueFilter({ priority: [4, "0"] }).priority, [0, 4]);
  });

  it("drops codes outside 0-4 instead of failing", () => {
    assert.deepEqual(parseIssueFilter({ status: "1,9,x,-1,1.5", priority: { a: 1 } }), {
      status: [1],
      priority: [],
      q: "",
      sort: "modified",
      dir: "desc",
    });
  });

  it("keeps a known sort and direction and ignores unknown ones", () => {
    assert.deepEqual(parseIssueFilter({ sort: "title", dir: "asc" }), { status: [], priority: [], q: "", sort: "title", dir: "asc" });
    assert.equal(parseIssueFilter({ sort: "version", dir: "up" }).sort, "modified");
    assert.equal(parseIssueFilter({ dir: "up" }).dir, "desc");
  });

  it("takes the title query as text, capped at 200 characters", () => {
    assert.equal(parseIssueFilter({ q: "sync" }).q, "sync");
    assert.equal(parseIssueFilter({ q: 42 }).q, "42");
    assert.equal(parseIssueFilter({ q: "x".repeat(300) }).q.length, 200);
  });
});

import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { openDocStore } from "@opfs-lsm/docstore";
import type { Db } from "@opfs-lsm/kv";
import { openHarnessDb } from "@opfs-lsm/kv/testing";
import type { Issue, PriorityCode, StatusCode } from "../domain/model.ts";
import { countByStatus, countTotal } from "./counts.ts";
import { parseIssueFilter } from "./filter.ts";
import { schema, stored, type IssueDocs } from "./store.ts";

const TITLES = [
  "Fix 100% CPU",
  "Fix 1000 CPU",
  "snake_case names",
  "Sync Cache",
  "sync the cache",
  "Caché misses",
  "naïve x-ray",
  "ab ab",
  "abab",
  "Windows C:\\temp path",
];

const issues: Issue[] = TITLES.flatMap((title, t) =>
  [0, 1, 2].map((k) => ({
    id: `${t}-${k}`,
    title,
    status: ((t + k) % 5) as StatusCode,
    priority: ((t * 2 + k) % 5) as PriorityCode,
    kanbanorder: `a${t}${k}`,
    username: "ada",
    created: t * 10 + k,
    modified: t * 10 + k,
    deleted: k === 2 && t % 3 === 0,
    version: 1,
  })),
);

/** What the list's `ilike` keeps: live issues under the filter whose title holds the query, ignoring case. */
function expected(q: string, status: readonly number[], priority: readonly number[]) {
  return issues.filter(
    (i) =>
      !i.deleted &&
      (status.length === 0 || status.includes(i.status)) &&
      (priority.length === 0 || priority.includes(i.priority)) &&
      i.title.toLowerCase().includes(q.toLowerCase()),
  );
}

let kv: Db;
let docs: IssueDocs;
before(async () => {
  kv = await openHarnessDb({ name: `linearlite-counts-${process.pid}`, forceMemory: true });
  docs = (await openDocStore(kv, schema)).collection("issues");
  await docs.putMany(issues.map(stored));
});
after(() => kv.close());

describe("issue counts", () => {
  const queries = ["", "fix", "FIX 1", "ix 10", "100%", "%", "_", "snake_case", "cache", "sync cache", "e n", "caché", "ï", "x-ray", "ab ab", "ab", "C:\\temp", "zzz"];
  const filters: [number[], number[]][] = [
    [[], []],
    [[0], []],
    [[1, 3], []],
    [[], [2]],
    [[2], [0, 4]],
  ];

  it("match the rows the list's ilike keeps, for every query and filter", async () => {
    for (const q of queries) {
      for (const [status, priority] of filters) {
        const filter = parseIssueFilter({ q, status: status.join(","), priority: priority.join(",") });
        const want = expected(q, status, priority);
        const what = JSON.stringify({ q, status, priority });
        assert.equal(await countTotal(docs, filter), want.length, what);
        const perStatus = [0, 1, 2, 3, 4].map((s) => want.filter((i) => i.status === s).length);
        assert.deepEqual(await countByStatus(docs, filter), perStatus, what);
      }
    }
  });

  it("pause after each status they count, and count the same as without pauses", async () => {
    for (const [status, priority] of filters) {
      const filter = parseIssueFilter({ status: status.join(","), priority: priority.join(",") });
      let pauses = 0;
      const pause = async () => {
        pauses++;
      };
      assert.deepEqual(await countByStatus(docs, filter, pause), await countByStatus(docs, filter));
      assert.equal(pauses, status.length > 0 ? status.length : 5);
    }
  });
});

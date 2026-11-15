import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { count, createCollection, createLiveQueryCollection, localOnlyCollectionOptions } from "@tanstack/db";
import type { Issue } from "../domain/model.ts";
import { parseIssueFilter } from "./filter.ts";
import { filtered, windowQuery } from "./query.ts";

type Issues = Parameters<typeof windowQuery>[0];

const TITLES = ["Fix 100% CPU", "Fix 1000 CPU", "snake_case names", "snakeXcase names", "Windows C:\\temp path", "Windows C:Xtemp path", "Sync Cache"];

async function seeded() {
  const issues = createCollection(localOnlyCollectionOptions<Issue>({ id: `q-${Math.random()}`, getKey: (i) => i.id }));
  await issues.preload();
  issues.insert(
    TITLES.map((title, n) => ({ id: String(n), title, status: 0, priority: 2, kanbanorder: `a${n}`, username: "ada", created: n, modified: n, deleted: false, version: 1 })),
  );
  return issues;
}

async function search(q: string, status?: 0): Promise<string[]> {
  const issues = await seeded();
  const query = windowQuery(issues as unknown as Issues, parseIssueFilter({ q, sort: "created", dir: "asc" }), 50, status);
  await query.preload();
  const titles = query.toArray.map((i) => i.title);
  await query.cleanup();
  return titles;
}

describe("title search", () => {
  it("matches a substring without regard to case", async () => {
    assert.deepEqual(await search("sync CACHE"), ["Sync Cache"]);
    assert.deepEqual(await search("fix 1"), ["Fix 100% CPU", "Fix 1000 CPU"]);
  });

  it("treats % and _ as the characters they are, not as wildcards", async () => {
    assert.deepEqual(await search("100%"), ["Fix 100% CPU"]);
    assert.deepEqual(await search("%"), ["Fix 100% CPU"]);
    assert.deepEqual(await search("snake_case"), ["snake_case names"]);
    assert.deepEqual(await search("_"), ["snake_case names"]);
  });

  it("treats a backslash as a plain character", async () => {
    assert.deepEqual(await search("C:\\temp"), ["Windows C:\\temp path"]);
  });

  it("applies in a board column too", async () => {
    assert.deepEqual(await search("100%", 0), ["Fix 100% CPU"]);
  });

  it("counts the same rows the list shows", async () => {
    const issues = await seeded();
    const total = createLiveQueryCollection((q) =>
      filtered(q, issues as unknown as Issues, parseIssueFilter({ q: "_" })).select(({ i }) => ({ n: count(i.id) })).findOne(),
    );
    await total.preload();
    assert.equal(total.toArray[0]?.n, 1);
    await total.cleanup();
  });
});

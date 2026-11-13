import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { openDocStore } from "@opfs-lsm/docstore";
import type { Db } from "@opfs-lsm/kv";
import { openHarnessDb } from "@opfs-lsm/kv/testing";
import { generateNKeysBetween } from "fractional-indexing";
import type { Issue, PriorityCode, StatusCode } from "../domain/model.ts";
import { parseIssueFilter } from "./filter.ts";
import { windowQuery } from "./query.ts";
import { collections, schema, transact, type Store } from "./store.ts";

const N = 500;
const WINDOW = 20;
const keys = generateNKeysBetween(null, null, N);
const issues: Issue[] = Array.from({ length: N }, (_, n) => ({
  id: `i${n}`,
  title: `Issue ${n}`,
  status: ((n * 3) % 5) as StatusCode,
  priority: (n % 5) as PriorityCode,
  kanbanorder: keys[(n * 7) % N]!,
  username: "ada",
  created: 1_700_000_000_000 + n,
  modified: 1_700_000_000_000 + ((n * 37) % N) * 1000,
  deleted: n % 50 === 0,
  version: 1,
}));

const live = () => issues.filter((i) => !i.deleted);
const desc = (a: number, b: number) => b - a;
const byPriority = (a: Issue, b: Issue) => desc(a.priority, b.priority) || desc(a.status, b.status) || desc(a.modified, b.modified);
const byStatus = (a: Issue, b: Issue) => a.status - b.status || (a.kanbanorder < b.kanbanorder ? -1 : 1);

let kv: Db;
let store: Store;
before(async () => {
  kv = await openHarnessDb({ name: `linearlite-sort-${process.pid}`, forceMemory: true });
  const docs = await openDocStore(kv, schema);
  store = { ...collections(docs), db: kv, docs };
  await transact(
    store,
    "issues",
    issues.map((i) => i.id),
    () => issues,
  );
});
after(() => kv.close());

async function shown(search: Record<string, string>, status?: StatusCode) {
  const query = windowQuery(store.issues, parseIssueFilter(search), WINDOW, status);
  await query.preload();
  const ids = query.toArray.map((i) => i.id);
  const held = store.issues.size;
  await query.cleanup();
  return { ids, held };
}

const ids = (rows: Issue[]) => rows.slice(0, WINDOW).map((i) => i.id);

describe("the list's sorts", () => {
  it("sorts by modified, newest first, holding about one window", async () => {
    const { ids: got, held } = await shown({});
    assert.deepEqual(got, ids(live().sort((a, b) => desc(a.modified, b.modified))));
    assert.ok(held < 2 * WINDOW, `holds ${held} issues`);
  });

  it("sorts by priority, then status, then newest, holding about one window", async () => {
    const { ids: got, held } = await shown({ sort: "priority", dir: "desc" });
    assert.deepEqual(got, ids(live().sort(byPriority)));
    assert.ok(held < 2 * WINDOW, `holds ${held} issues, not the ${N / 5} that share a priority`);
  });

  it("sorts by status, then board order, in either direction", async () => {
    assert.deepEqual((await shown({ sort: "status", dir: "asc" })).ids, ids(live().sort(byStatus)));
    assert.deepEqual((await shown({ sort: "status", dir: "desc" })).ids, ids(live().sort((a, b) => byStatus(b, a))));
  });

  it("keeps a filter on the sorted field", async () => {
    const want = live()
      .filter((i) => i.priority === 0 || i.priority === 3)
      .sort(byPriority);
    assert.deepEqual((await shown({ sort: "priority", dir: "desc", priority: "0,3" })).ids, ids(want));
  });

  it("orders a board column by kanbanorder", async () => {
    const want = live()
      .filter((i) => i.status === 2)
      .sort(byStatus);
    assert.deepEqual((await shown({ sort: "priority" }, 2)).ids, ids(want));
  });

  it("moves an issue whose priority an edit changes", async () => {
    const last = live().sort(byPriority).at(-1)!;
    await transact(store, "issues", [last.id], ([row]) => [{ ...row!, priority: 4, status: 4, modified: Date.now() }]);
    assert.equal((await shown({ sort: "priority", dir: "desc" })).ids[0], last.id);
  });
});

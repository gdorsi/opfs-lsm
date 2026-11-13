import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { openDocStore } from "@opfs-lsm/docstore";
import type { Db } from "@opfs-lsm/kv";
import { openHarnessDb } from "@opfs-lsm/kv/testing";
import { docstoreCollectionOptions } from "@opfs-lsm/tanstack-db";
import { createCollection, localOnlyCollectionOptions } from "@tanstack/db";
import type { Issue, PriorityCode, StatusCode } from "../domain/model.ts";
import { anchors, countBefore, locate } from "./counts.ts";
import { parseIssueFilter, SORT_FIELDS, type IssueFilter } from "./filter.ts";
import { windowQuery } from "./query.ts";
import { schema, stored, type IssueDocs, type Store, type StoredIssue } from "./store.ts";

const N = 400;
const SIZE = 30;

/** Few distinct values per field, so every sort has ties, and priority and status ties longer than `locate` reads. */
const issue = (k: number): StoredIssue =>
  stored({
  id: `i${String((k * 7919) % 1000).padStart(3, "0")}-${k}`,
  title: ["alpha", "beta", "gamma", "delta"][k % 4]! + (k % 13),
  status: (k % 5) as StatusCode,
  priority: ((k * 3) % 5) as PriorityCode,
  kanbanorder: `a${k}`,
  username: "ada",
  created: Math.floor(k / 2),
  modified: Math.floor(k / 3),
  deleted: k % 17 === 0,
  version: 1,
  });

let kv: Db;
let docs: IssueDocs;
let issues: Store["issues"];
let every: Store["issues"];

before(async () => {
  kv = await openHarnessDb({ name: `linearlite-window-${process.pid}`, forceMemory: true });
  docs = (await openDocStore(kv, schema)).collection("issues");
  const all = Array.from({ length: N }, (_, k) => issue(k));
  await docs.putMany(all);
  issues = createCollection(
    docstoreCollectionOptions({ collection: docs, syncMode: "on-demand", defaultStringCollation: { stringSort: "lexical" } }),
  ) as unknown as Store["issues"];
  every = createCollection(
    localOnlyCollectionOptions<StoredIssue>({ id: "every", getKey: (i) => i.id, initialData: all, defaultStringCollation: { stringSort: "lexical" } }),
  ) as unknown as Store["issues"];
});
after(async () => {
  await issues.cleanup();
  await every.cleanup();
  await kv.close();
});

const ids = (q: { toArray: readonly Issue[] }) => q.toArray.map((i) => i.id);

/** The rows a window at `n` shows when TanStack holds every issue. */
async function expected(filter: IssueFilter, n: number): Promise<string[]> {
  const q = windowQuery(every, filter, SIZE, undefined, { offset: n });
  await q.preload();
  const rows = ids(q);
  await q.cleanup();
  return rows;
}

const filters = SORT_FIELDS.flatMap((sort) => (["asc", "desc"] as const).map((dir) => parseIssueFilter({ sort, dir })));
const live = () => every.toArray.filter((i) => !i.deleted).length;

describe("the list's anchored window", () => {
  it("shows the rows TanStack shows at the same position when it holds every issue", async () => {
    for (const filter of filters) {
      for (const n of [0, 1, 63, 64, 65, 66, 129, 200, live() - SIZE, live() - 1]) {
        const what = JSON.stringify({ sort: filter.sort, dir: filter.dir, n });
        const anchor = await locate(docs, filter, n);
        assert.ok(anchor, what);
        assert.ok(anchor.base <= n, what);
        assert.equal(await countBefore(docs, filter, anchor.value), anchor.base, what);
        const q = windowQuery(issues, filter, SIZE, undefined, { from: anchor.value, offset: n - anchor.base });
        await q.preload();
        assert.deepEqual(ids(q), await expected(filter, n), what);
        await q.cleanup();
      }
    }
  });

  it("does not anchor the list by title, whose index orders an emoji after U+FF21 and whose list orders it before", () => {
    const [emoji, fullwidth] = ["\u{1F600}", "\uFF21"];
    assert.ok(emoji < fullwidth, "the list's order");
    assert.ok(Buffer.compare(Buffer.from(emoji), Buffer.from(fullwidth)) > 0, "the index's order");
    for (const dir of ["asc", "desc"] as const) assert.equal(anchors(parseIssueFilter({ sort: "title", dir })), false);
    for (const sort of SORT_FIELDS) if (sort !== "title") assert.equal(anchors(parseIssueFilter({ sort })), true, sort);
    assert.equal(anchors(parseIssueFilter({ q: "a" })), false);
  });

  it("has no anchor past the end of the list", async () => {
    const filter = parseIssueFilter({});
    assert.equal(await locate(docs, filter, live()), undefined);
    assert.equal(await locate(docs, filter, live() + 500), undefined);
  });

  it("keeps showing the right rows at the right position as writes move rows across its anchor", async () => {
    const filter = parseIssueFilter({});
    const n = 200;
    const anchor = (await locate(docs, filter, n))!;
    const offset = n - anchor.base;
    const q = windowQuery(issues, filter, SIZE, undefined, { from: anchor.value, offset });
    await q.preload();
    const byModified = () => every.toArray.filter((i) => !i.deleted).sort((a, b) => b.modified - a.modified || (a.id < b.id ? -1 : 1));
    const write = async (id: string, change: Partial<Issue>) => {
      const doc = stored({ ...every.get(id)!, ...change });
      await docs.put(doc);
      every.update(id, (draft) => Object.assign(draft, doc));
    };
    const at = (k: number) => byModified()[k]!.id;
    for (const [what, run] of [
      ["a row below the window moves to the top", () => write(at(n + 100), { modified: 10_000 })],
      ["a row inside the window moves to the top", () => write(at(n + 5), { modified: 10_001 })],
      ["a row above the window moves to the top", () => write(at(10), { modified: 10_002 })],
      ["a row above the window is deleted", () => write(at(20), { deleted: true })],
      ["a row from the top moves into the window", () => write(at(0), { modified: anchor.value as number })],
    ] as const) {
      await run();
      const base = await countBefore(docs, filter, anchor.value);
      for (let i = 0; i < 100; i++) {
        if (JSON.stringify(ids(q)) === JSON.stringify(await expected(filter, base + offset))) break;
        await new Promise((r) => setTimeout(r, 2));
      }
      assert.deepEqual(ids(q), await expected(filter, base + offset), what);
    }
    await q.cleanup();
  });
});

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { createCollection, createLiveQueryCollection, localOnlyCollectionOptions, type Collection } from "@tanstack/db";
import { generateNKeysBetween } from "fractional-indexing";
import { stored, type Body, type Comment, type Issue, type PriorityCode, type StatusCode, type StoredIssue } from "../domain/model.ts";
import type { Backend, StoreName, StoreRows } from "../model/backend.ts";
import { parseIssueFilter, SORT_FIELDS, type IssueFilter, type SortField } from "../model/filter.ts";
import type { Unsubscribe } from "../model/live.ts";
import { bodyOf, commentsOf, issueById, unsent, windowQuery } from "../model/query.ts";

/** A fresh, empty backend stored under `name`, and how to release all it holds. */
export type OpenBackend = (name: string) => Promise<{ readonly backend: Backend; close(): Promise<void> }>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits up to 5 s for `read()` to equal `want`, then asserts that it does. */
async function eventually<T>(read: () => T, want: T, what: string): Promise<void> {
  for (let i = 0; i < 250 && !isDeepStrictEqual(read(), want); i++) await sleep(20);
  assert.deepEqual(read(), want, what);
}

/** The last value a watch emitted, kept until `stop`. */
function watched<T>(watch: (emit: (value: T) => void) => Unsubscribe) {
  const seen: { value?: T } = {};
  const stop = watch((value) => (seen.value = value));
  return { latest: () => seen.value, stop };
}

/** What a live query over the backend's collection shows once loaded and settled. */
async function shown<T extends object>(query: Collection<T, string | number>, waitFor?: (rows: T[]) => boolean): Promise<T[]> {
  await query.preload();
  for (let i = 0; i < 250 && waitFor && !waitFor(query.toArray); i++) await sleep(20);
  return query.toArray;
}

const put = <S extends StoreName>(backend: Backend, store: S, rows: readonly StoreRows[S][]) =>
  backend.transact(store, rows as readonly (StoreRows[S] & { readonly id: string })[], (_, row) => row);

const ids = (rows: readonly { readonly id: string }[]) => rows.map((r) => r.id);
/** `row`'s fields that `like` has, so a stored issue compares with the issue it was written from. */
const fieldsOf = (row: object | undefined, like: object | undefined) =>
  row && like && Object.fromEntries(Object.keys(like).map((k) => [k, (row as Record<string, unknown>)[k]]));

const issue = (k: number, over: Partial<Issue> = {}): Issue => ({
  id: `i${k}`,
  title: `Issue ${k}`,
  status: (k % 5) as StatusCode,
  priority: ((k * 3) % 5) as PriorityCode,
  kanbanorder: `a${k}`,
  username: "ada",
  created: k,
  modified: k,
  deleted: false,
  version: 1,
  ...over,
});

/**
 * What every backend must do for the model. A backend joins by calling this once more in `contract.test.ts`. The
 * expected values come from the rows the test wrote, not from any backend.
 */
export function contract(label: string, open: OpenBackend): void {
  describe(`the ${label} backend`, () => {
    let n = 0;
    /** A fresh backend for the enclosing `describe`, released after it. */
    const fresh = () => {
      const opened = { backend: undefined as unknown as Backend, close: async () => {} };
      before(async () => Object.assign(opened, await open(`contract-${label}-${process.pid}-${n++}`)));
      after(() => opened.close());
      return () => opened.backend;
    };

    describe("transact", () => {
      const backend = fresh();

      it("merges each item with its own stored row: creates, updates, deletes with null, leaves with undefined", async () => {
        const N = 1000;
        await put(backend(), "issues", Array.from({ length: N }, (_, k) => issue(k)));
        const items = Array.from({ length: 2 * N }, (_, k) => ({ id: `i${k}`, k }));
        const locals: (string | undefined)[] = [];
        await backend().transact("issues", items, (local, { k }) => {
          locals[k] = local?.id;
          if (k >= N) return issue(k);
          if (k % 3 === 0) return { ...local!, title: `edited ${k}` };
          return k % 3 === 1 ? null : undefined;
        });
        assert.deepEqual(locals, items.map(({ id, k }) => (k < N ? id : undefined)), "merge got each item's stored row");
        const want = items.map(({ k }) => (k >= N || k % 3 === 2 ? issue(k) : k % 3 === 0 ? issue(k, { title: `edited ${k}` }) : undefined));
        const rows = await backend().read("issues", ids(items));
        assert.deepEqual(rows.map((row, i) => fieldsOf(row, want[i]) ?? row), want);
      });

      it("drops the keys a merge leaves out, so an acknowledged edit loses `dirty` and `pending` and leaves the outbox", async () => {
        const outbox = unsent(backend().collection("bodies"));
        const draft: Body = { id: "b1", description: "draft", version: 0, dirty: { description: 1 }, pending: true };
        await put(backend(), "bodies", [draft]);
        assert.deepEqual(ids(await shown(outbox, (rows) => rows.length === 1)), ["b1"]);
        await backend().transact("bodies", [{ id: "b1" }], (local) => {
          const { dirty: _dirty, pending: _pending, ...clean } = local!;
          return { ...clean, version: 1 };
        });
        assert.deepEqual(await backend().read("bodies", ["b1", "b2"]), [{ id: "b1", description: "draft", version: 1 }, undefined]);
        await eventually(() => outbox.size, 0, "the outbox is empty");
        await outbox.cleanup();
      });

      it("derives an issue's sort keys from the row a merge returns, which may carry stale ones", async () => {
        const list = windowQuery(backend().collection("issues"), parseIssueFilter({ sort: "priority", dir: "desc" }), 5);
        await shown(list);
        await backend().transact("issues", [{ id: "i5" }], (local) => ({ ...local!, priority: 4, status: 4, modified: 10_000 }));
        await eventually(() => list.toArray[0]?.id, "i5", "the edited issue sorts first by priority");
        assert.equal(list.toArray[0]!.priorityOrder, stored({ ...issue(5), priority: 4, status: 4, modified: 10_000 }).priorityOrder);
        await list.cleanup();
      });
    });

    describe("the views' queries", () => {
      const backend = fresh();
      const N = 500;
      const keys = generateNKeysBetween(null, null, N);
      const all: Issue[] = Array.from({ length: N }, (_, k) =>
        issue(k, {
          kanbanorder: keys[(k * 7) % N]!,
          created: 1_700_000_000_000 + k,
          modified: 1_700_000_000_000 + ((k * 37) % N) * 1000,
          deleted: k % 50 === 0,
        }),
      );
      const live = () => all.filter((i) => !i.deleted);
      const desc = (a: number, b: number) => b - a;
      const text = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
      const ORDERS: Record<SortField, (a: Issue, b: Issue) => number> = {
        modified: (a, b) => a.modified - b.modified,
        created: (a, b) => a.created - b.created,
        title: (a, b) => text(a.title, b.title),
        priority: (a, b) => a.priority - b.priority || a.status - b.status || a.modified - b.modified,
        status: (a, b) => a.status - b.status || text(a.kanbanorder, b.kanbanorder),
      };
      const windowOf = async (filter: IssueFilter, size: number, offset = 0, status?: StatusCode) => {
        const query = windowQuery(backend().collection("issues"), filter, size, status, offset > 0 ? { offset } : undefined);
        const rows = ids(await shown(query));
        await query.cleanup();
        return rows;
      };
      const comments: Comment[] = [3, 1, 2].map((t) => ({
        key: `i1/c${t}`,
        id: `c${t}`,
        issue_id: "i1",
        body: `comment ${t}`,
        username: "ada",
        created: t,
        deleted: t === 2,
        version: 1,
      }));

      before(async () => {
        await put(backend(), "issues", all);
        await put(backend(), "bodies", [{ id: "i1", description: "the first issue", version: 1 }]);
        await put(backend(), "comments", comments);
      });

      it("list a window under every sort, in either direction, at the top and further down", async () => {
        for (const sort of SORT_FIELDS) {
          for (const dir of ["asc", "desc"] as const) {
            const order = live().sort((a, b) => (dir === "asc" ? 1 : -1) * ORDERS[sort](a, b));
            const filter = parseIssueFilter({ sort, dir });
            assert.deepEqual(await windowOf(filter, 20), ids(order.slice(0, 20)), `${sort} ${dir}`);
            assert.deepEqual(await windowOf(filter, 20, 100), ids(order.slice(100, 120)), `${sort} ${dir} at 100`);
          }
        }
      });

      it("list the issues under a status, priority or search filter", async () => {
        const byPriority = (a: Issue, b: Issue) => -ORDERS.priority(a, b);
        const byModified = (a: Issue, b: Issue) => desc(a.modified, b.modified);
        for (const [search, keep, order] of [
          [{ status: "1,3", sort: "priority" }, (i: Issue) => i.status === 1 || i.status === 3, byPriority],
          [{ priority: "0,3", sort: "priority" }, (i: Issue) => i.priority === 0 || i.priority === 3, byPriority],
          [{ q: "issue 4" }, (i: Issue) => i.title.toLowerCase().includes("issue 4"), byModified],
        ] as const) {
          assert.deepEqual(await windowOf(parseIssueFilter(search), 20), ids(live().filter(keep).sort(order).slice(0, 20)), JSON.stringify(search));
        }
      });

      it("list a board column by board order", async () => {
        const want = live()
          .filter((i) => i.status === 2)
          .sort(ORDERS.status);
        assert.deepEqual(await windowOf(parseIssueFilter({ sort: "priority" }), 20, 0, 2), ids(want.slice(0, 20)));
      });

      it("read one issue, and nothing for a tombstone", async () => {
        const one = createLiveQueryCollection(issueById(backend().collection("issues"), "i7"));
        assert.deepEqual(ids(await shown(one)), ["i7"]);
        const tombstone = createLiveQueryCollection(issueById(backend().collection("issues"), "i50"));
        assert.deepEqual(await shown(tombstone), []);
        await Promise.all([one.cleanup(), tombstone.cleanup()]);
      });

      it("read an issue's description, and its live comments oldest first", async () => {
        const body = createLiveQueryCollection(bodyOf(backend().collection("bodies"), "i1"));
        assert.deepEqual(ids(await shown(body)), ["i1"]);
        const thread = createLiveQueryCollection(commentsOf(backend().collection("comments"), "i1"));
        assert.deepEqual(ids(await shown(thread)), ["c1", "c3"]);
        await Promise.all([body.cleanup(), thread.cleanup()]);
      });
    });

    describe("counts", () => {
      const backend = fresh();
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
      const rows: Issue[] = TITLES.flatMap((title, t) =>
        [0, 1, 2].map((k) =>
          issue(t * 3 + k, {
            title,
            status: ((t + k) % 5) as StatusCode,
            priority: ((t * 2 + k) % 5) as PriorityCode,
            deleted: k === 2 && t % 3 === 0,
          }),
        ),
      );
      /** What the list's `ilike` keeps: live issues under the filter whose title holds the query, ignoring case. */
      const counted = (filter: IssueFilter) => {
        const kept = rows.filter(
          (i) =>
            !i.deleted &&
            (filter.status.length === 0 || filter.status.includes(i.status)) &&
            (filter.priority.length === 0 || filter.priority.includes(i.priority)) &&
            i.title.toLowerCase().includes(filter.q.toLowerCase()),
        );
        return { total: kept.length, byStatus: [0, 1, 2, 3, 4].map((s) => kept.filter((i) => i.status === s).length) };
      };
      const queries = ["", "fix", "FIX 1", "ix 10", "100%", "%", "_", "snake_case", "cache", "sync cache", "e n", "caché", "ï", "x-ray", "ab ab", "ab", "C:\\temp", "zzz"];
      const filters: [number[], number[]][] = [
        [[], []],
        [[0], []],
        [[1, 3], []],
        [[], [2]],
        [[2], [0, 4]],
      ];

      before(() => put(backend(), "issues", rows));

      it("match the rows the list's ilike keeps, for every query and filter", async () => {
        for (const q of queries) {
          for (const [status, priority] of filters) {
            const filter = parseIssueFilter({ q, status: status.join(","), priority: priority.join(",") });
            const want = counted(filter);
            const what = JSON.stringify({ q, status, priority });
            const total = watched((emit: (n: number) => void) => backend().watchTotal(filter, emit));
            const byStatus = watched((emit: (n: readonly number[]) => void) => backend().watchCounts(filter, emit));
            await eventually(total.latest, want.total, `total ${what}`);
            await eventually(byStatus.latest, want.byStatus, `per status ${what}`);
            total.stop();
            byStatus.stop();
          }
        }
      });

      it("count again after writes", async () => {
        const watches = [parseIssueFilter({}), parseIssueFilter({ q: "cache", status: "0,1,2" })].map((filter) => ({
          filter,
          total: watched((emit: (n: number) => void) => backend().watchTotal(filter, emit)),
          byStatus: watched((emit: (n: readonly number[]) => void) => backend().watchCounts(filter, emit)),
        }));
        for (const { filter, total, byStatus } of watches) {
          await eventually(total.latest, counted(filter).total, `total before writes under ${JSON.stringify(filter)}`);
          await eventually(byStatus.latest, counted(filter).byStatus, `per status before writes under ${JSON.stringify(filter)}`);
        }
        const [syncCache, syncTheCache] = [rows[9]!, rows[13]!];
        assert.deepEqual([syncCache.title, syncCache.status, syncTheCache.title, syncTheCache.deleted], ["Sync Cache", 3, "sync the cache", false]);
        const edits = [
          { ...syncCache, status: 0 as StatusCode },
          { ...syncTheCache, deleted: true },
          issue(100, { title: "cache me", status: 1 }),
          issue(101, { title: "Cache 2", status: 2 }),
        ];
        await put(backend(), "issues", edits);
        rows.splice(9, 1, edits[0]!);
        rows.splice(13, 1, edits[1]!);
        rows.push(edits[2]!, edits[3]!);
        for (const { filter, total, byStatus } of watches) {
          await eventually(total.latest, counted(filter).total, `total after writes under ${JSON.stringify(filter)}`);
          await eventually(byStatus.latest, counted(filter).byStatus, `per status after writes under ${JSON.stringify(filter)}`);
          total.stop();
          byStatus.stop();
        }
      });
    });

    describe("clear", () => {
      const backend = fresh();
      const comment = (k: number): Comment => ({ key: `i1/c${k}`, id: `c${k}`, issue_id: "i1", body: `c${k}`, username: "ada", created: k, deleted: false, version: 1 });

      it("drops every row of a stream from storage and from live queries, and takes new rows after", async () => {
        await put(backend(), "comments", [comment(1), comment(2)]);
        await put(backend(), "issues", [issue(1)]);
        const thread = createLiveQueryCollection(commentsOf(backend().collection("comments"), "i1"));
        assert.deepEqual(ids(await shown(thread)), ["c1", "c2"]);
        await backend().clear("comments");
        assert.deepEqual(await backend().read("comments", ["c1", "c2"]), [undefined, undefined]);
        await eventually(() => ids(thread.toArray), [], "the thread shows no comment");
        assert.deepEqual(ids(await backend().read("issues", ["i1"]) as Issue[]), ["i1"], "other streams keep their rows");
        await put(backend(), "comments", [comment(3)]);
        await eventually(() => ids(thread.toArray), ["c3"], "the thread shows a comment written after the clear");
        await thread.cleanup();
      });

      it("clears a stream that is already empty", async () => {
        await backend().clear("bodies");
        await backend().clear("bodies");
        assert.deepEqual(await backend().read("bodies", ["b1"]), [undefined]);
      });
    });

    describe("anchor, when present", () => {
      const backend = fresh();
      const N = 400;
      const SIZE = 30;
      /** Few distinct values per field, so every sort has ties, and priority and status ties longer than 64 rows. */
      const all: Issue[] = Array.from({ length: N }, (_, k) => ({
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
      }));
      /** Every issue in memory, as the reference: the rows a window at `n` shows when TanStack holds them all. */
      const every = createCollection(
        localOnlyCollectionOptions<StoredIssue>({ id: `every-${label}`, getKey: (i) => i.id, initialData: all.map(stored), defaultStringCollation: { stringSort: "lexical" } }),
      ) as unknown as Collection<StoredIssue, string>;
      const expected = async (filter: IssueFilter, n: number) => {
        const q = windowQuery(every, filter, SIZE, undefined, { offset: n });
        const rows = ids(await shown(q));
        await q.cleanup();
        return rows;
      };
      const live = () => every.toArray.filter((i) => !i.deleted).length;
      const anchorable = () =>
        SORT_FIELDS.flatMap((sort) => (["asc", "desc"] as const).map((dir) => parseIssueFilter({ sort, dir }))).filter(
          (filter) => backend().anchor?.(filter) !== undefined,
        );

      before(() => put(backend(), "issues", all));
      after(() => every.cleanup());

      it("starts a window at row n that shows the rows the list shows there", async (t) => {
        if (!backend().anchor) return t.skip("this backend does not anchor");
        assert.ok(anchorable().length > 0, "anchors some list");
        for (const filter of anchorable()) {
          const anchoring = backend().anchor!(filter)!;
          for (const n of [0, 1, 63, 64, 65, 66, 129, 200, live() - SIZE, live() - 1]) {
            const what = JSON.stringify({ sort: filter.sort, dir: filter.dir, n });
            const anchor = await anchoring.locate(n);
            assert.ok(anchor && anchor.base <= n, what);
            const base = watched((emit: (b: number) => void) => anchoring.watchBase(anchor.value, emit));
            await eventually(base.latest, anchor.base, `base ${what}`);
            base.stop();
            const q = windowQuery(backend().collection("issues"), filter, SIZE, undefined, { from: anchor.value, offset: n - anchor.base });
            assert.deepEqual(ids(await shown(q)), await expected(filter, n), what);
            await q.cleanup();
          }
        }
      });

      it("has no anchor past the end of the list", async (t) => {
        if (!backend().anchor) return t.skip("this backend does not anchor");
        const anchoring = backend().anchor!(anchorable()[0]!)!;
        assert.equal(await anchoring.locate(live()), undefined);
        assert.equal(await anchoring.locate(live() + 500), undefined);
      });

      it("keeps showing the right rows at the right position as writes move rows across its anchor", async (t) => {
        if (!backend().anchor) return t.skip("this backend does not anchor");
        const filter = parseIssueFilter({});
        const n = 200;
        const anchoring = backend().anchor!(filter)!;
        const anchor = (await anchoring.locate(n))!;
        const offset = n - anchor.base;
        const q = windowQuery(backend().collection("issues"), filter, SIZE, undefined, { from: anchor.value, offset });
        await shown(q);
        const base = watched((emit: (b: number) => void) => anchoring.watchBase(anchor.value, emit));
        const byModified = () => every.toArray.filter((i) => !i.deleted).sort((a, b) => b.modified - a.modified || (a.id < b.id ? -1 : 1));
        const write = async (id: string, change: Partial<Issue>) => {
          const row = stored({ ...every.get(id)!, ...change });
          await put(backend(), "issues", [row]);
          every.update(id, (draft) => Object.assign(draft, row));
        };
        const at = (k: number) => byModified()[k]!.id;
        for (const [what, run] of [
          ["a row below the window moves to the top", () => write(at(n + 100), { modified: 10_000 })],
          ["a row inside the window moves to the top", () => write(at(n + 5), { modified: 10_001 })],
          ["a row above the window moves to the top", () => write(at(10), { modified: 10_002 })],
          ["a row above the window is deleted", () => write(at(20), { deleted: true })],
          ["a row from the top moves into the window", () => write(at(0), { modified: anchor.value as number })],
        ] as const) {
          const was = base.latest();
          await run();
          const before = byModified().filter((i) => (filter.dir === "desc" ? i.modified > (anchor.value as number) : i.modified < (anchor.value as number))).length;
          await eventually(base.latest, before, `base after: ${what} (was ${was})`);
          const want = await expected(filter, before + offset);
          await eventually(() => ids(q.toArray), want, what);
        }
        base.stop();
        await q.cleanup();
      });
    });
  });
}

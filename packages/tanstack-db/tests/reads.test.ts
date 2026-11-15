/**
 * Which documents an on-demand collection reads to serve a live query, seen
 * through a docstore collection that counts what its snapshots return.
 */
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { defineSchema, openDocStore, type Collection, type CollectionSnapshot } from "@opfs-lsm/docstore";
import type { Db } from "@opfs-lsm/kv";
import { openHarnessDb } from "@opfs-lsm/kv/testing";
import { and, count, createCollection, createLiveQueryCollection, eq, ilike, inArray } from "@tanstack/db";
import { docstoreCollectionOptions } from "../src/index.ts";

type Issue = { id: string; deleted: boolean; status: number; modified: number; title: string };

const schema = defineSchema<{ issues: Issue }>()({
  version: 1,
  collections: {
    issues: {
      byModified: { by: ["deleted", "modified"] },
      byStatus: { by: ["deleted", "status", "modified"] },
      search: { by: ["deleted", "modified"], text: "title" },
    },
  },
});

const N = 2000;
const issue = (i: number): Issue => ({
  id: `i${String(i).padStart(5, "0")}`,
  deleted: i % 10 === 0,
  status: i % 5,
  modified: Math.floor(i / 4),
  title: i % 7 === 0 ? `fix the bug ${i}` : `feature ${i}`,
});
const ISSUES = Array.from({ length: N }, (_, i) => issue(i));

type ReadLog = { index: string; eq: unknown[]; docs: number }[];

/** `issues` whose snapshots log each query: the index, its pinned values and how many documents it returned. */
function counting(issues: Collection<Issue, any>, log: ReadLog): Collection<Issue, any> {
  const wrap = (snap: CollectionSnapshot<Issue, any>): CollectionSnapshot<Issue, any> => ({
    seq: snap.seq,
    get: (id) => snap.get(id),
    getMany: async (ids) => {
      const docs = await snap.getMany(ids);
      log.push({ index: "(ids)", eq: [], docs: docs.filter(Boolean).length });
      return docs;
    },
    query: async (q) => {
      const page = await snap.query(q);
      log.push({ index: q.index ?? "(rows)", eq: [...((q as { readonly eq?: readonly unknown[] }).eq ?? [])], docs: page.docs.length });
      return page;
    },
    queryIds: (q) => snap.queryIds(q),
    count: (q) => snap.count(q),
  });
  return new Proxy(issues, {
    get(target, prop) {
      if (prop === "view") return (body: (s: CollectionSnapshot<Issue, any>) => Promise<unknown>) => target.view((s) => body(wrap(s)));
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

let kv: Db;
let issues: Collection<Issue, any>;
before(async () => {
  kv = await openHarnessDb({ name: `tsdb-reads-${process.pid}`, forceMemory: true, maxWalBytes: 1 << 30 });
  issues = (await openDocStore(kv, schema)).collection("issues");
  await issues.putMany(ISSUES);
});
after(() => kv.close());

async function serve<R extends object>(build: (c: ReturnType<typeof onDemand>) => { preload(): Promise<void>; toArray: R[]; cleanup(): Promise<void> }) {
  const log: ReadLog = [];
  const c = onDemand(counting(issues, log));
  const q = build(c);
  await q.preload();
  const rows = q.toArray;
  await q.cleanup();
  await c.cleanup();
  return { log, rows, read: log.reduce((n, r) => n + r.docs, 0) };
}

const onDemand = (c: Collection<Issue, any>) => createCollection(docstoreCollectionOptions({ collection: c, syncMode: "on-demand" }));

const expected = (keep: (i: Issue) => boolean) => ISSUES.filter(keep);

test("a window of a list ordered by an index path reads a page of that index, and its tie from the same index", async () => {
  const { log, rows, read } = await serve((c) =>
    createLiveQueryCollection((q) =>
      q
        .from({ i: c })
        .where(({ i }) => eq(i.deleted, false))
        .orderBy(({ i }) => i.modified, { direction: "desc", nulls: "last" })
        .limit(20),
    ),
  );
  const want = expected((i) => !i.deleted).sort((a, b) => b.modified - a.modified).slice(0, 20);
  assert.deepEqual(rows.map((r) => r.modified), want.map((i) => i.modified));
  assert.ok(log.every((r) => r.index === "byModified"), JSON.stringify(log));
  const last = want.at(-1)!.modified;
  assert.ok(log.some((r) => r.eq.length === 2 && r.eq[1] === last), "the tie load pins the boundary value");
  assert.ok(read < 60, `read ${read} documents of ${N}`);
});

test("an in over a pinned prefix reads one page per value", async () => {
  const { log, rows, read } = await serve((c) =>
    createLiveQueryCollection((q) =>
      q
        .from({ i: c })
        .where(({ i }) => and(eq(i.deleted, false), inArray(i.status, [1, 3])))
        .orderBy(({ i }) => i.modified, { direction: "desc", nulls: "last" })
        .limit(10),
    ),
  );
  assert.equal(rows.length, 10);
  const ranges = log.filter((r) => r.eq.length === 2);
  assert.deepEqual(new Set(ranges.map((r) => `${r.index} ${JSON.stringify(r.eq)}`)), new Set(['byStatus [false,1]', 'byStatus [false,3]']));
  assert.ok(read < 60, `read ${read} documents of ${N}`);
});

test("TanStack's default order options, locale strings and nulls first, read a page of a number path", async () => {
  const { log, read } = await serve((c) =>
    createLiveQueryCollection((q) =>
      q
        .from({ i: c })
        .where(({ i }) => eq(i.deleted, false))
        .orderBy(({ i }) => i.modified, "desc")
        .limit(20),
    ),
  );
  assert.ok(log.every((r) => r.index === "byModified"), JSON.stringify(log));
  assert.ok(read < 80, `read ${read} documents of ${N}`);
});

test("a search reads the text index with the pattern's words", async () => {
  const { log, rows, read } = await serve((c) =>
    createLiveQueryCollection((q) =>
      q
        .from({ i: c })
        .where(({ i }) => and(eq(i.deleted, false), ilike(i.title, "%bug%")))
        .orderBy(({ i }) => i.modified, { direction: "desc", nulls: "last" })
        .limit(10),
    ),
  );
  assert.equal(rows.length, 10);
  assert.ok(log.every((r) => r.index === "search"), JSON.stringify(log));
  assert.ok(read < 40, `read ${read} documents of ${N}`);
});

test("a string order without stringSort lexical reads every matching document", async () => {
  const { log, read } = await serve((c) =>
    createLiveQueryCollection((q) => q.from({ i: c }).orderBy(({ i }) => i.title).limit(5)),
  );
  assert.ok(log.some((r) => r.index === "(rows)"));
  assert.ok(read >= N, `read ${read}`);
});

test("an aggregate reads every row its where matches, through the index", async () => {
  const { log, rows, read } = await serve((c) =>
    createLiveQueryCollection((q) =>
      q
        .from({ i: c })
        .where(({ i }) => and(eq(i.deleted, false), eq(i.status, 2)))
        .select(({ i }) => ({ n: count(i.id) })),
    ),
  );
  const matching = expected((i) => !i.deleted && i.status === 2).length;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.n, matching);
  assert.deepEqual(log.map((r) => r.index), ["byStatus"]);
  assert.equal(read, matching);
});

test("a where on the id reads those documents only", async () => {
  const { log, read } = await serve((c) =>
    createLiveQueryCollection((q) => q.from({ i: c }).where(({ i }) => inArray(i.id, ["i00001", "i00002", "nope"]))),
  );
  assert.deepEqual(log.map((r) => r.index), ["(ids)"]);
  assert.equal(read, 2);
});

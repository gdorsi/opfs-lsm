import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, test } from "node:test";
import { collection, defineSchema, openDocStore } from "@opfs-lsm/docstore";
import type { Db } from "@opfs-lsm/kv";
import { openHarnessDb } from "@opfs-lsm/kv/testing";
import { createCollection, createLiveQueryCollection, eq, localOnlyCollectionOptions } from "@tanstack/db";
import { docstoreCollectionOptions } from "../src/index.ts";

type Issue = { id: string; title: string };
type Comment = { id: string; issue_id: string; body: string };

const schema = defineSchema({
  version: 1,
  collections: {
    issues: collection<Issue>(),
    comments: collection<Comment>().index("byIssue", "issue_id"),
  },
});

const opened: Db[] = [];
const cleanups: { cleanup(): Promise<void> }[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c.cleanup();
  for (const db of opened.splice(0)) await db.close();
});
const tracked = <C extends { cleanup(): Promise<void> }>(c: C): C => (cleanups.push(c), c);

async function settle(done: () => boolean, what: string) {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(done(), `timed out waiting for ${what}`);
}

const pairs = (rows: readonly { i: Issue; c?: Comment }[]) => rows.map((r) => `${r.i.id}:${r.c?.id ?? "-"}`).sort();

// TanStack loads the on-demand side of a join lazily, with an inArray over the join keys it holds.
test("a join onto an on-demand collection shows each issue's comments, and follows new issues and other tabs' comments", async () => {
  const name = `tsdb${randomUUID().slice(0, 8)}`;
  const kv = await openHarnessDb({ name, forceMemory: true, maxWalBytes: 1 << 30 });
  const otherKv = await openHarnessDb({ name, forceMemory: true, maxWalBytes: 1 << 30 });
  opened.push(kv, otherKv);
  const other = (await openDocStore(otherKv, schema)).collection("comments");
  await other.putMany([
    { id: "c1", issue_id: "i1", body: "one" },
    { id: "c2", issue_id: "i2", body: "two" },
    { id: "c3", issue_id: "i3", body: "three" },
    { id: "c4", issue_id: "i9", body: "nobody's" },
  ]);
  await kv.sync();

  const issues = tracked(
    createCollection(
      localOnlyCollectionOptions({
        getKey: (i: Issue) => i.id,
        initialData: [
          { id: "i1", title: "first" },
          { id: "i2", title: "second" },
        ],
      }),
    ),
  );
  const store = await openDocStore(kv, schema);
  const comments = tracked(createCollection(docstoreCollectionOptions({ collection: store.collection("comments"), syncMode: "on-demand" })));
  const joined = tracked(
    createLiveQueryCollection((q) =>
      q
        .from({ i: issues })
        .join({ c: comments }, ({ i, c }) => eq(i.id, c.issue_id), "left")
        .select(({ i, c }) => ({ i, c })),
    ),
  );
  await joined.preload();
  await settle(() => joined.size === 2, "the first join");
  assert.deepEqual(pairs(joined.toArray as never), ["i1:c1", "i2:c2"]);
  assert.equal(comments.has("c4"), false, "a comment no issue joins stays out of memory");

  await other.put({ id: "c5", issue_id: "i1", body: "another" });
  await settle(() => joined.size === 3, "the other tab's comment");
  issues.insert({ id: "i3", title: "third" });
  const want = ["i1:c1", "i1:c5", "i2:c2", "i3:c3"].join();
  await settle(() => pairs(joined.toArray as never).join() === want, "the new issue's comment");

  await other.put({ id: "c3", issue_id: "i2", body: "moved" });
  await settle(() => pairs(joined.toArray as never).join() === ["i1:c1", "i1:c5", "i2:c2", "i2:c3", "i3:-"].join(), "the moved comment");
});

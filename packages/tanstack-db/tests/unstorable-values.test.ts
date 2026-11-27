import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { collection, defineSchema, openDocStore } from "@opfs-lsm/docstore";
import { openHarnessDb } from "@opfs-lsm/kv/testing";
import {
  createCollection,
  createLiveQueryCollection,
  eq,
  gt,
  inArray,
  lt,
  localOnlyCollectionOptions,
  type Collection,
} from "@tanstack/db";
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

const ISSUES: Issue[] = [
  { id: "a", title: "first" },
  { id: "b", title: "second" },
];
const COMMENTS: Comment[] = [
  { id: "c1", issue_id: "a", body: "on a" },
  { id: "c2", issue_id: "", body: "on no issue" },
];

async function setup() {
  const kv = await openHarnessDb({ name: `t${randomUUID().replaceAll("-", "").slice(0, 16)}`, forceMemory: true });
  const store = await openDocStore(kv, schema);
  await store.collection("issues").putMany(ISSUES);
  await store.collection("comments").putMany(COMMENTS);
  const issues = createCollection(docstoreCollectionOptions({ collection: store.collection("issues"), syncMode: "on-demand" }));
  const comments = createCollection(docstoreCollectionOptions({ collection: store.collection("comments"), syncMode: "on-demand" }));
  const reference = {
    issues: createCollection(localOnlyCollectionOptions({ getKey: (d: Issue) => d.id, initialData: ISSUES })),
    comments: createCollection(localOnlyCollectionOptions({ getKey: (d: Comment) => d.id, initialData: COMMENTS })),
  };
  return { kv, issues, comments, reference };
}

const ids = (q: { toArray: readonly { id: string }[] }) => q.toArray.map((r) => r.id).sort();

test("an on-demand where on the id shows what TanStack shows when the list holds an id docstore cannot store", async () => {
  const { kv, issues, reference } = await setup();
  const got: unknown[] = [];
  const want: unknown[] = [];
  try {
    for (const where of [
      (d: any) => inArray(d.id, ["a", ""]),
      (d: any) => eq(d.id, ""),
      (d: any) => inArray(d.id, ["b", "x".repeat(1025)]),
    ]) {
      const query = (source: Collection<Issue, string, any>) =>
        createLiveQueryCollection((q) => q.from({ i: source }).where(({ i }) => where(i)));
      const reading = createLiveQueryCollection((q) => q.from({ i: reference.issues }).where(({ i }) => where(i)));
      await reading.preload();
      want.push(ids(reading as never));
      const live = query(issues);
      try {
        await live.preload();
        got.push(ids(live as never));
      } catch (error) {
        got.push(`rejected: ${String(error)}`);
      }
      await Promise.all([live.cleanup(), reading.cleanup()]);
    }
    assert.deepEqual(got, want);
  } finally {
    await issues.cleanup();
    await kv.close();
  }
});

test("a join onto an on-demand collection shows the rows TanStack shows when a foreign key is the empty string", async () => {
  const { kv, issues, comments, reference } = await setup();
  const join = (i: Collection<Issue, string, any>, c: Collection<Comment, string, any>) =>
    createLiveQueryCollection((q) =>
      q
        .from({ c })
        .join({ i }, ({ c, i }) => eq(c.issue_id, i.id), "left")
        .select(({ c, i }) => ({ id: c.id, title: i?.title })),
    );
  const want = join(reference.issues, reference.comments);
  const got = join(issues, comments);
  try {
    await want.preload();
    let outcome: unknown;
    try {
      await got.preload();
      outcome = got.toArray.map((r: any) => [r.id, r.title ?? null]).sort();
    } catch (error) {
      outcome = `rejected: ${String(error)}`;
    }
    assert.deepEqual(outcome, want.toArray.map((r: any) => [r.id, r.title ?? null]).sort());
  } finally {
    await Promise.all([got.cleanup(), want.cleanup()]);
    await Promise.all([issues.cleanup(), comments.cleanup()]);
    await kv.close();
  }
});

test("an on-demand where on an indexed field shows what TanStack shows when a value is longer than an index key holds", async () => {
  const { kv, comments, reference } = await setup();
  const long = "x".repeat(9000);
  const got: unknown[] = [];
  const want: unknown[] = [];
  try {
    for (const where of [
      (d: any) => eq(d.issue_id, long),
      (d: any) => inArray(d.issue_id, ["a", long]),
      (d: any) => gt(d.issue_id, long),
      (d: any) => lt(d.issue_id, long),
    ]) {
      const reading = createLiveQueryCollection((q) => q.from({ c: reference.comments }).where(({ c }) => where(c)));
      await reading.preload();
      want.push(ids(reading as never));
      const live = createLiveQueryCollection((q) => q.from({ c: comments }).where(({ c }) => where(c)));
      try {
        await live.preload();
        got.push(ids(live as never));
      } catch (error) {
        got.push(`rejected: ${String(error)}`);
      }
      await Promise.all([live.cleanup(), reading.cleanup()]);
    }
    assert.deepEqual(got, want);
  } finally {
    await comments.cleanup();
    await kv.close();
  }
});

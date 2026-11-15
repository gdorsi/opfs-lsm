import { defineSchema, openDocStore, type DocStore } from "@opfs-lsm/docstore";
import { openDb, type Db } from "@opfs-lsm/kv";
import { docstoreCollectionOptions } from "@opfs-lsm/tanstack-db";
import { createCollection, createLiveQueryCollection, eq } from "@tanstack/db";
import type { Body, Comment, Issue, Rows, StoredIssue, SyncState } from "../domain/model.ts";
import { STORES, type Stream } from "../domain/stores.ts";

/** Priority, then status, then `modified` (ms, below 1e13): one value per issue, so a sort on it has few ties. */
export const priorityOrder = (priority: number, status: number, modified: number) => priority * 1e14 + status * 1e13 + modified;

export const stored = (issue: Issue): StoredIssue => ({
  ...issue,
  priorityOrder: priorityOrder(issue.priority, issue.status, issue.modified),
  statusOrder: `${issue.status}${issue.kanbanorder}`,
});

const indexes = Object.fromEntries(Object.entries(STORES).map(([name, store]) => [name, store.indexes])) as {
  [N in keyof typeof STORES]: (typeof STORES)[N]["indexes"];
};

/** The indexes are in `STORES`; the reads each issue index serves are in DESIGN.md, "Indexes". */
export const schema = defineSchema<{ issues: StoredIssue; bodies: Body; comments: Comment; sync: SyncState }>()({
  version: 4,
  collections: indexes,
  drop: ["outbox"],
});

export type Docs = DocStore<typeof schema>;
const issueDocs = (docs: Docs) => docs.collection("issues");
export type IssueDocs = ReturnType<typeof issueDocs>;

export function collections(docs: Docs) {
  const issues = createCollection(
    docstoreCollectionOptions({
      collection: issueDocs(docs),
      syncMode: STORES.issues.load,
      defaultStringCollation: { stringSort: "lexical" },
    }),
  );
  const bodies = createCollection(docstoreCollectionOptions({ collection: docs.collection("bodies"), syncMode: STORES.bodies.load }));
  const comments = createCollection(docstoreCollectionOptions({ collection: docs.collection("comments"), syncMode: STORES.comments.load }));
  const sync = createCollection(docstoreCollectionOptions({ collection: docs.collection("sync"), syncMode: STORES.sync.load }));
  const dirtyIssues = createLiveQueryCollection((q) => q.from({ i: issues }).where(({ i }) => eq(i.pending, true)));
  const dirtyBodies = createLiveQueryCollection((q) => q.from({ b: bodies }).where(({ b }) => eq(b.pending, true)));
  const dirtyComments = createLiveQueryCollection((q) => q.from({ c: comments }).where(({ c }) => eq(c.pending, true)));
  return { issues, bodies, comments, sync, dirtyIssues, dirtyBodies, dirtyComments };
}

export type Store = ReturnType<typeof collections> & {
  readonly db: Db;
  readonly docs: Docs;
  readonly user: string;
};

/** The shape of stored rows. The sync leader clears a replica written under another format and pulls it again. */
export const FORMAT = 4;

type Merge<T> = (rows: ReadonlyArray<T | undefined>) => ReadonlyArray<T | null | undefined>;
type Transact<T> = (ids: readonly string[], merge: Merge<T>) => Promise<void>;

/** Every write of rows. An issue gets its sort keys from the fields `merge` returns, so no write leaves them stale. */
export function transact<S extends Stream>(store: Store, stream: S, ids: readonly string[], merge: Merge<Rows[S]>): Promise<void> {
  if (stream !== "issues") return (store[stream].utils.transact as unknown as Transact<Rows[S]>)(ids, merge);
  const issues = merge as unknown as Merge<Issue>;
  return store.issues.utils.transact(ids, (rows) => issues(rows).map((row) => row && stored(row)));
}

let opening: Promise<Store> | undefined;
let opened: Store | undefined;

export function openStore(): Promise<Store> {
  return (opening ??= (async () => {
    const params = new URLSearchParams(location.search);
    // `?maxBytes=` sets a byte cap, to see an eviction without filling the disk.
    const db = await openDb({ name: params.get("db") ?? "linearlite", maxBytes: Number(params.get("maxBytes")) || "quota" });
    const docs = await openDocStore(db, schema);
    const store: Store = { db, docs, user: params.get("user") ?? "anonymous", ...collections(docs) };
    await store.sync.preload();
    opened = store;
    return store;
  })());
}

export function openedStore(): Store {
  if (!opened) throw new Error("openStore() has not resolved yet");
  return opened;
}

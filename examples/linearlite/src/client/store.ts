import { defineSchema, openDocStore, type DocStore } from "@opfs-lsm/docstore";
import { openDb, type Db } from "@opfs-lsm/kv";
import { docstoreCollectionOptions } from "@opfs-lsm/tanstack-db";
import { createCollection, createLiveQueryCollection, eq } from "@tanstack/db";
import type { Body, Comment, Issue, SyncState } from "../domain/model.ts";

export type OutboxMark = {
  readonly id: string;
  readonly stream: "bodies" | "comments";
  readonly rowKey: string;
  readonly nonce: string;
};

export const outboxKey = (stream: OutboxMark["stream"], rowKey: string) => `${stream}:${rowKey}`;

/** The reads each issue index serves are in DESIGN.md, "Indexes". */
const schema = defineSchema<{ issues: Issue; bodies: Body; comments: Comment; sync: SyncState; outbox: OutboxMark }>()({
  version: 2,
  collections: {
    issues: {
      byModified: { on: ["deleted", "modified"] },
      byCreated: { on: ["deleted", "created"] },
      byTitle: { on: ["deleted", "title"] },
      byPriority: { on: ["deleted", "priority", "status"] },
      byStatus: { on: ["deleted", "status", "kanbanorder"] },
      search: { on: ["deleted", "modified"], text: "title" },
      pending: { on: "pending" },
    },
    bodies: {},
    comments: { byIssue: { on: "issue_id" } },
    sync: {},
    outbox: {},
  },
});

export type Docs = DocStore<typeof schema>;
const issueDocs = (docs: Docs) => docs.collection("issues");
export type IssueDocs = ReturnType<typeof issueDocs>;

function collections(docs: Docs) {
  const issues = createCollection(
    docstoreCollectionOptions({
      collection: issueDocs(docs),
      syncMode: "on-demand",
      defaultStringCollation: { stringSort: "lexical" },
    }),
  );
  const bodies = createCollection(docstoreCollectionOptions({ collection: docs.collection("bodies"), syncMode: "on-demand" }));
  const comments = createCollection(docstoreCollectionOptions({ collection: docs.collection("comments"), syncMode: "on-demand" }));
  const sync = createCollection(docstoreCollectionOptions({ collection: docs.collection("sync") }));
  const outbox = createCollection(docstoreCollectionOptions({ collection: docs.collection("outbox") }));
  const dirtyIssues = createLiveQueryCollection((q) => q.from({ i: issues }).where(({ i }) => eq(i.pending, true)));
  return { issues, bodies, comments, sync, outbox, dirtyIssues };
}

export type Store = ReturnType<typeof collections> & {
  readonly db: Db;
  readonly docs: Docs;
  readonly user: string;
};

let opening: Promise<Store> | undefined;
let opened: Store | undefined;

export function openStore(): Promise<Store> {
  return (opening ??= (async () => {
    const params = new URLSearchParams(location.search);
    const db = await openDb({ name: params.get("db") ?? "linearlite" });
    const docs = await openDocStore(db, schema);
    const store: Store = { db, docs, user: params.get("user") ?? "anonymous", ...collections(docs) };
    await Promise.all([store.sync.preload(), store.outbox.preload()]);
    opened = store;
    return store;
  })());
}

export function openedStore(): Store {
  if (!opened) throw new Error("openStore() has not resolved yet");
  return opened;
}

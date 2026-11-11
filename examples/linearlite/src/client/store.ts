import { defineSchema, openDocStore, type DocStore } from "@opfs-lsm/docstore";
import { openDb, type Db } from "@opfs-lsm/kv";
import { docstoreCollectionOptions } from "@opfs-lsm/tanstack-db";
import { BTreeIndex, createCollection, createLiveQueryCollection, isUndefined, not } from "@tanstack/db";
import type { Body, Comment, Issue, SyncState } from "../domain/model.ts";

export type OutboxMark = {
  readonly id: string;
  readonly stream: "bodies" | "comments";
  readonly rowKey: string;
  readonly nonce: string;
};

export const outboxKey = (stream: OutboxMark["stream"], rowKey: string) => `${stream}:${rowKey}`;

const schema = defineSchema<{ issues: Issue; bodies: Body; comments: Comment; sync: SyncState; outbox: OutboxMark }>()({
  version: 1,
  collections: {
    issues: {},
    bodies: {},
    comments: { byIssue: { on: "issue_id" } },
    sync: {},
    outbox: {},
  },
});

type Docs = DocStore<typeof schema>;

function collections(docs: Docs) {
  const issues = createCollection(docstoreCollectionOptions({ collection: docs.collection("issues") }));
  for (const field of ["status", "priority", "modified", "created", "kanbanorder"] as const) {
    issues.createIndex((i) => i[field], { indexType: BTreeIndex });
  }
  const bodies = createCollection(docstoreCollectionOptions({ collection: docs.collection("bodies"), syncMode: "on-demand" }));
  const comments = createCollection(docstoreCollectionOptions({ collection: docs.collection("comments"), syncMode: "on-demand" }));
  const sync = createCollection(docstoreCollectionOptions({ collection: docs.collection("sync") }));
  const outbox = createCollection(docstoreCollectionOptions({ collection: docs.collection("outbox") }));
  const dirtyIssues = createLiveQueryCollection((q) => q.from({ i: issues }).where(({ i }) => not(isUndefined(i.dirty))));
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
    await Promise.all([store.issues.preload(), store.sync.preload(), store.outbox.preload()]);
    opened = store;
    return store;
  })());
}

export function openedStore(): Store {
  if (!opened) throw new Error("openStore() has not resolved yet");
  return opened;
}

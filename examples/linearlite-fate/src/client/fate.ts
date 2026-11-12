import { createIndexedDBStorage } from "@nkzw/fate-indexeddb";
import { createPersistence, type PersistenceStorage } from "@nkzw/fate/persistence";
import { kvStorage } from "@opfs-lsm/fate";
import { openDb } from "@opfs-lsm/kv";
import type { RequestOptions } from "@nkzw/fate";
import { clientRoot, clientValueRoot, createClient, createHTTPTransport, mutation, view } from "react-fate";
import {
  PERSISTENCE_KEY,
  type ColumnArgs,
  type CommentEntity,
  type FilterArgs,
  type IssueEntity,
  type IssuePatch,
  type NewComment,
  type NewIssue,
  type StatusCounts,
  type WindowArgs,
} from "../domain/model.ts";

export const IssueRowView = view<IssueEntity>()({
  id: true,
  title: true,
  status: true,
  priority: true,
  kanbanorder: true,
  username: true,
  created: true,
  modified: true,
});
export const CommentView = view<CommentEntity>()({ id: true, body: true, username: true, created: true });
export const CommentsView = { items: { node: CommentView } } as const;
export const IssueDetailView = view<IssueEntity>()({ id: true, description: true, comments: CommentsView });
/** A list window is complete as fetched; a board column pages forward. */
export const WindowView = { items: { node: IssueRowView } } as const;
export const ColumnView = { items: { node: IssueRowView }, pagination: { hasNext: true, nextCursor: true } } as const;

const roots = {
  issues: clientRoot<IssueEntity[], "Issue", WindowArgs>("Issue"),
  column: clientRoot<IssueEntity[], "Issue", ColumnArgs>("Issue"),
  issue: clientRoot<IssueEntity, "Issue">("Issue"),
  counts: clientValueRoot<StatusCounts, FilterArgs>(),
};

const mutations = {
  updateIssue: mutation<IssueEntity, IssuePatch & { id: string }, IssueEntity>("Issue"),
  createIssue: mutation<IssueEntity, NewIssue, IssueEntity>("Issue"),
  deleteIssue: mutation<IssueEntity, { id: string }, null>("Issue"),
  addComment: mutation<CommentEntity, NewComment, CommentEntity>("Comment"),
};

/** Every screen paints what the device holds and refreshes it from the server; what it fetched stays three days. */
export const REQUEST = { mode: "stale-while-revalidate", persist: { maxAge: 3 * 24 * 3600 * 1000 } } as const satisfies RequestOptions;

function makeClient(storage: PersistenceStorage, user: string | null) {
  return createClient<[typeof roots, typeof mutations]>({
    roots,
    mutations,
    types: [{ type: "Issue", fields: { comments: { listOf: "Comment" } } }, { type: "Comment" }],
    transport: createHTTPTransport({ url: "/api/fate", live: false, headers: user ? { "x-linearlite-user": user } : {} }),
    persistence: createPersistence({ key: PERSISTENCE_KEY, storage }),
  });
}
export type Fate = ReturnType<typeof makeClient>;

declare module "@nkzw/fate" {
  interface ClientRegistration {
    client: Fate;
  }
}

/** `kv` stores fate's cache and queue through `@opfs-lsm/fate`, `idb` through fate's own IndexedDB storage. */
export type StorageKind = "kv" | "idb";
export type Opened = { readonly fate: Fate; readonly storage: StorageKind; readonly user: string };

let opening: Promise<Opened> | undefined;
let opened: Opened | undefined;

export function openFate(): Promise<Opened> {
  return (opening ??= (async () => {
    performance.mark("fate:open-start");
    const params = new URLSearchParams(location.search);
    const kind: StorageKind = params.get("storage") === "idb" ? "idb" : "kv";
    const storage = kind === "idb" ? createIndexedDBStorage() : kvStorage(await openDb({ name: params.get("db") ?? "linearlite" }));
    // IndexedDB opens its database on first use, so for `idb` this mark is early and `fate:ready` holds the open.
    performance.mark("fate:storage-open");
    const fate = makeClient(storage, params.get("user"));
    await fate.persistence!.ready;
    performance.mark("fate:ready");
    opened = { fate, storage: kind, user: params.get("user") ?? "anonymous" };
    return opened;
  })());
}

export function openedFate(): Opened {
  if (!opened) throw new Error("openFate() has not resolved yet");
  return opened;
}

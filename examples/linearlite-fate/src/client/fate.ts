import { createIndexedDBStorage } from "@nkzw/fate-indexeddb";
import { createPersistence, type PersistenceStorage } from "@nkzw/fate/persistence";
import { kvStorage } from "@opfs-lsm/fate";
import { openDb } from "@opfs-lsm/kv";
import type { RequestOptions } from "@nkzw/fate";
import { createContext, useContext } from "react";
import { clientRoot, clientValueRoot, createClient, createHTTPTransport, mutation } from "react-fate";
import {
  persistenceKey,
  userName,
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
/** Reads the cache, restoring from the device; never fetches, suspends or throws. */
export const CACHE_ONLY = { mode: "cache-only" } as const;

function makeClient(storage: PersistenceStorage, user: string) {
  return createClient<[typeof roots, typeof mutations]>({
    roots,
    mutations,
    types: [{ type: "Issue", fields: { comments: { listOf: "Comment" } } }, { type: "Comment" }],
    transport: createHTTPTransport({ url: "/api/fate", live: false, headers: { "x-linearlite-user": user } }),
    persistence: createPersistence({ key: persistenceKey(user), storage }),
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
/** Who is signed in and where the cache lives: fixed for the page, provided next to the client. */
export type Session = { readonly user: string; readonly storage: StorageKind };
export type Opened = Session & { readonly fate: Fate };

let opening: Promise<Opened> | undefined;

/** Creates the client once the user is known (`?user=`), and waits until its persistence has restored. */
export function openFate(): Promise<Opened> {
  return (opening ??= (async () => {
    performance.mark("fate:open-start");
    const params = new URLSearchParams(location.search);
    const user = userName(params.get("user"));
    const kind: StorageKind = params.get("storage") === "idb" ? "idb" : "kv";
    const storage = kind === "idb" ? createIndexedDBStorage() : kvStorage(await openDb({ name: params.get("db") ?? "linearlite" }));
    // IndexedDB opens its database on first use, so for `idb` this mark is early and `fate:ready` holds the open.
    performance.mark("fate:storage-open");
    const fate = makeClient(storage, user);
    await fate.persistence!.ready;
    performance.mark("fate:ready");
    return { fate, storage: kind, user };
  })());
}

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession() outside the app shell");
  return session;
}

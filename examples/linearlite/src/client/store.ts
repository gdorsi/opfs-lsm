import { openDb, type Db } from "@opfs-lsm/kv";
import { kvCollectionOptions } from "@opfs-lsm/tanstack-db";
import {
  BTreeIndex,
  createCollection,
  createLiveQueryCollection,
  isUndefined,
  not,
  parseLoadSubsetOptions,
  type LoadSubsetOptions,
} from "@tanstack/db";
import type { Body, Comment, Issue, SyncState } from "../domain/model.ts";

export interface OutboxMark {
  readonly key: string;
  readonly stream: "bodies" | "comments";
  readonly rowKey: string;
  readonly nonce: string;
}

export const outboxKey = (stream: OutboxMark["stream"], rowKey: string) => `${stream}:${rowKey}`;

function collections(db: Db) {
  const issues = createCollection(kvCollectionOptions({ db, name: "issues", getKey: (i: Issue) => i.id }));
  for (const field of ["status", "priority", "modified", "created", "kanbanorder"] as const) {
    issues.createIndex((i) => i[field], { indexType: BTreeIndex });
  }
  const bodies = createCollection(
    kvCollectionOptions({ db, name: "bodies", getKey: (b: Body) => b.id, onDemand: { plan: planBodies } }),
  );
  const comments = createCollection(
    kvCollectionOptions({ db, name: "comments", getKey: (c: Comment) => c.key, onDemand: { plan: planComments } }),
  );
  const sync = createCollection(kvCollectionOptions({ db, name: "sync", getKey: (s: SyncState) => s.id }));
  const outbox = createCollection(kvCollectionOptions({ db, name: "outbox", getKey: (m: OutboxMark) => m.key }));
  const dirtyIssues = createLiveQueryCollection((q) => q.from({ i: issues }).where(({ i }) => not(isUndefined(i.dirty))));
  return { issues, bodies, comments, sync, outbox, dirtyIssues };
}

export type Store = ReturnType<typeof collections> & {
  readonly db: Db;
  readonly user: string;
};

function planBodies(options: LoadSubsetOptions): { keys: string[] } {
  for (const f of parseLoadSubsetOptions(options).filters) {
    if (f.field.join(".") !== "id") continue;
    if (f.operator === "eq" && typeof f.value === "string") return { keys: [f.value] };
    if (f.operator === "in" && Array.isArray(f.value)) return { keys: f.value.filter((v) => typeof v === "string") };
  }
  throw new Error("bodies load only by eq(id, X) or inArray(id, [...])");
}

function planComments(options: LoadSubsetOptions): { prefix: string } {
  const f = parseLoadSubsetOptions(options).filters.find((f) => f.field.join(".") === "issue_id" && f.operator === "eq");
  if (typeof f?.value !== "string") throw new Error("comments load only by eq(issue_id, X)");
  return { prefix: `${f.value}/` };
}

let opening: Promise<Store> | undefined;
let opened: Store | undefined;

export function openStore(): Promise<Store> {
  return (opening ??= (async () => {
    const params = new URLSearchParams(location.search);
    const db = await openDb({ name: params.get("db") ?? "linearlite" });
    const store: Store = { db, user: params.get("user") ?? "anonymous", ...collections(db) };
    await Promise.all([store.issues.preload(), store.sync.preload(), store.outbox.preload()]);
    opened = store;
    return store;
  })());
}

export function openedStore(): Store {
  if (!opened) throw new Error("openStore() has not resolved yet");
  return opened;
}

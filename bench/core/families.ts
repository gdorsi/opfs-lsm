/**
 * One interface per comparison family. A workload is written once against
 * its family's interface and every contender adapts its library to it, so
 * "the same ops on each side" holds by construction.
 *
 * Each interface sits at the grain the libraries' fast paths expose: one
 * `putMany` is one kv batch and one IndexedDB readwrite transaction.
 */
import type { StorageAdapterInterface } from "@automerge/react";
import type { KvStats } from "@opfs-lsm/kv/testing";
import type { experimental_createQueryPersister, StoragePersisterOptions } from "@tanstack/query-persist-client-core";
import type { GoalStore } from "./goals.ts";
import type { TrackerSpec, Tx as TrackerTx } from "../datasets/tracker/types.ts";
import type * as Y from "yjs";

export type Bytes = Uint8Array;

type Common = {
  /** Bring background work to rest (kv: flush and compact until stable). No-op without an engine. Untimed. */
  settle(): Promise<void>;
  /** kv engine counters; undefined for contenders without a kv engine. */
  stats(): Promise<KvStats | undefined>;
  close(): Promise<void>;
};

/** kv vs raw IndexedDB. */
export type KvStore = Common & {
  putMany(entries: readonly (readonly [Bytes, Bytes])[]): Promise<void>;
  deleteMany(keys: readonly Bytes[]): Promise<void>;
  get(key: Bytes): Promise<Bytes | undefined>;
  /** One read for every key, in the order asked. */
  getMany(keys: readonly Bytes[]): Promise<(Bytes | undefined)[]>;
  /** Values of keys in [start, endExclusive), ascending, or descending with `reverse`, at most `limit`, past the first `offset` in that order. */
  range(start: Bytes, endExclusive: Bytes | undefined, limit: number, offset?: number, reverse?: boolean): Promise<Bytes[]>;
  /** How many keys [start, endExclusive) holds. */
  count(start: Bytes, endExclusive: Bytes): Promise<number>;
  /** Catch up with every write another tab acked before the call. A no-op where every read already sees them. */
  sync(): Promise<void>;
  /** Read-modify-write of one key that no other write gets inside (YCSB F). `f` may run more than once: its last run counts. */
  update(key: Bytes, f: (old: Bytes | undefined) => Bytes): Promise<void>;
};

/** The todo row the TanStack DB adapter workloads write. */
export type Todo = {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
  /** One of OWNERS: a low-cardinality field for equality lookups. */
  readonly owner: string;
  /** Unique, ascending with id: the ordered index. */
  readonly createdAt: number;
};
export const OWNERS = 16;

/** TanStack DB collections: docstoreCollectionOptions vs indexedDBCollectionOptions. Reads are TanStack's in-memory rows on both sides, so the timed work is persistence and load. */
export type CollectionStore = Common & {
  /** One TanStack transaction with every row. Resolves once the store persisted it. */
  insertMany(rows: readonly Todo[]): Promise<void>;
  /** One transaction with one row. */
  insert(row: Todo): Promise<void>;
  /** One transaction that changes each of `ids` with `f`. */
  updateMany(ids: readonly string[], f: (row: Todo) => Todo): Promise<void>;
  deleteMany(ids: readonly string[]): Promise<void>;
  /** The collection's in-memory row. Used to check results, not timed as a read benchmark. */
  get(id: string): Todo | undefined;
  size(): number;
};

/** One live query over the todo rows. Each kind is one index read on both sides. */
export type TodoQuery =
  | { readonly kind: "owner"; readonly owner: string }
  /** Up to `limit` rows of `owner` with createdAt >= from, ascending. */
  | { readonly kind: "page"; readonly owner: string; readonly from: number; readonly limit: number }
  | { readonly kind: "ids"; readonly ids: readonly string[] };

/** A live query that keeps its rows in the collection until `release`. */
export type HeldQuery = { readonly rows: readonly Todo[]; release(): Promise<void> };

/** TanStack DB collections in on-demand mode: docstoreCollectionOptions vs TanStack's SQLite persistence. A row is in memory only while a live query holds it. */
export type OnDemandStore = Common & {
  /** One TanStack transaction with every row. Resolves once the store persisted it. */
  insertMany(rows: readonly Todo[]): Promise<void>;
  /** Starts a live query and resolves once its first result is ready. */
  hold(q: TodoQuery): Promise<HeldQuery>;
  /** One transaction that changes each of `ids` with `f`. Every id must be in a held query. */
  updateMany(ids: readonly string[], f: (row: Todo) => Todo): Promise<void>;
};

/** Automerge: both contenders are automerge-repo storage adapters; workloads drive a real Repo. */
export type AutomergeStore = Common & {
  readonly adapter: StorageAdapterInterface;
};

/** Yjs: one persistence provider per doc, many docs per store. */
export type YjsStore = Common & {
  /** Attach persistence to `doc` under `docName`; resolves once its stored state is applied. */
  attach(docName: string, doc: Y.Doc): Promise<YjsBinding>;
};

export type YjsBinding = {
  /** Resolves once every update so far is acknowledged by storage. */
  flush(): Promise<void>;
  detach(): Promise<void>;
  /** Detach, then delete this doc's stored data. The binding is unusable after. */
  clear(): Promise<void>;
};

/**
 * TanStack Query persistence: a contender builds `experimental_createQueryPersister` over its storage with the
 * workload's options. Workloads build the QueryClient, so both run the same client code.
 */
export type QueryStore = Common & {
  persister(options: Omit<StoragePersisterOptions<string>, "storage">): ReturnType<typeof experimental_createQueryPersister<string>>;
};

/** The task-tracker dataset's goals: each contender replays the history through its write API and answers every goal with its own query API. */
export type TrackerStore = Common & GoalStore<TrackerSpec, TrackerTx>;

/** The tracker goals a screen shows as one ordered, limited list of cards: the ones a TanStack DB live query answers. */
export const SCREENS = ["statusPage", "labelPage", "myIssues", "recentActivity"] as const satisfies readonly (keyof TrackerSpec)[];
export type Screen = (typeof SCREENS)[number];

/** One screen's live query. TanStack DB keeps it current; `answer` reads it as the screen would render it. */
export type LiveScreen<S extends Screen = Screen> = {
  answer(): TrackerSpec[S]["answer"];
  close(): Promise<void>;
};

/** TanStack DB live queries over the tracker's users, projects, labels and issues. */
export type LiveStore = Common & {
  /** One transaction of the tracker history through TanStack collection writes. Resolves once it is persisted and every open screen shows it. */
  apply(tx: TrackerTx): Promise<void>;
  /** Starts the screen's live query; resolves at its first answer. */
  open<S extends Screen>(screen: S, params: TrackerSpec[S]["params"]): Promise<LiveScreen<S>>;
};

/** Family name → store interface. The directory names under workloads/ and contenders/ are these keys. */
export type FamilyStores = {
  kv: KvStore;
  tanstack: CollectionStore;
  "tanstack-ondemand": OnDemandStore;
  automerge: AutomergeStore;
  yjs: YjsStore;
  "tanstack-query": QueryStore;
  tracker: TrackerStore;
  "tanstack-live": LiveStore;
};

export const FAMILIES: readonly (keyof FamilyStores)[] = ["kv", "tanstack", "tanstack-ondemand", "automerge", "yjs", "tanstack-query", "tracker", "tanstack-live"];

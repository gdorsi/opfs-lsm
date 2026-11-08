/**
 * One interface per comparison family. A workload is written once against
 * its family's interface and every contender adapts its library to it, so
 * "the same ops on each side" holds by construction.
 *
 * Each interface sits at the grain the libraries' fast paths expose: one
 * `putMany` is one kv batch, one IndexedDB readwrite transaction, one Dexie
 * `bulkPut`.
 */
import type { StorageAdapterInterface } from "@automerge/react";
import type { KvStats } from "@opfs-lsm/kv/testing";
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
  /** Values of keys in [start, endExclusive), ascending, at most `limit`. */
  range(start: Bytes, endExclusive: Bytes | undefined, limit: number): Promise<Bytes[]>;
  /** Read-modify-write of one key in one transaction (YCSB F). */
  update(key: Bytes, f: (old: Bytes | undefined) => Bytes): Promise<void>;
};

/** The one table both table contenders declare. */
export type Todo = {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
  /** One of OWNERS: a low-cardinality field for equality lookups. */
  readonly owner: string;
  /** Unique, ascending with id: the ordered index. */
  readonly createdAt: number;
};
export const TODO_TABLE = "todos";
export const OWNER_INDEX = "byOwner";
export const CREATED_INDEX = "byCreated";
export const OWNERS = 16;

/** collections vs Dexie. */
export type TableStore = Common & {
  putMany(rows: readonly Todo[]): Promise<void>;
  put(row: Todo): Promise<void>;
  get(id: string): Promise<Todo | undefined>;
  getMany(ids: readonly string[]): Promise<(Todo | undefined)[]>;
  /** Every row with `owner`, via the owner index. */
  whereOwner(owner: string): Promise<Todo[]>;
  /** Up to `limit` rows with createdAt >= from, ascending, via the createdAt index. */
  pageByCreated(from: number, limit: number): Promise<Todo[]>;
  /** Read-modify-write of one row in one transaction. */
  update(id: string, f: (row: Todo) => Todo): Promise<void>;
  deleteMany(ids: readonly string[]): Promise<void>;
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
};

/** Family name → store interface. The directory names under workloads/ and contenders/ are these keys. */
export type FamilyStores = {
  kv: KvStore;
  table: TableStore;
  automerge: AutomergeStore;
  yjs: YjsStore;
};

export const FAMILIES: readonly (keyof FamilyStores)[] = ["kv", "table", "automerge", "yjs"];

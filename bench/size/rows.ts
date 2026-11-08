/**
 * The bundle-size rows: the import an app writes to use each library. Each
 * row becomes an entry of the bench's Vite build; size.ts measures what the
 * bundler emitted for it. Budgets are brotli bytes after open (entry, its
 * static imports, and everything they load later: workers, wasm).
 */
export type SizeRow = {
  readonly id: string;
  readonly source: string;
  readonly note: string;
  /** Includes kv: must reach exactly one SharedWorker chunk and one .wasm. */
  readonly kv?: true;
  /** Fail `bench:size --check` when brotli-after-open exceeds this many bytes. */
  readonly budget?: number;
};

export const SIZE_ROWS: readonly SizeRow[] = [
  {
    id: "kv",
    kv: true,
    source: `export { openDb } from "@opfs-lsm/kv";`,
    note: "openDb: main-thread JS + SharedWorker + wasm",
    budget: 66_500,
  },
  {
    id: "collections",
    kv: true,
    source: `export { openCollectionDb } from "@opfs-lsm/collections";`,
    note: "openCollectionDb, includes kv",
    budget: 70_000,
  },
  { id: "dexie", source: `export { default } from "dexie";`, note: "Dexie" },
  { id: "yjs", source: `export * as Y from "yjs";`, note: "yjs alone, to subtract from the two rows below" },
  {
    id: "yjs+kv",
    kv: true,
    source: `export { KvPersistence } from "@opfs-lsm/example-yjs/kv-persistence"; export { openDb } from "@opfs-lsm/kv"; export * as Y from "yjs";`,
    note: "yjs + KvPersistence + kv",
  },
  {
    id: "yjs+y-indexeddb",
    source: `export { IndexeddbPersistence } from "y-indexeddb"; export * as Y from "yjs";`,
    note: "yjs + y-indexeddb",
  },
  {
    id: "automerge-adapter-kv",
    kv: true,
    source: `export { kvStorage } from "@opfs-lsm/example-automerge/storage"; export { openDb } from "@opfs-lsm/kv";`,
    note: "automerge-repo storage adapter on kv, includes kv",
  },
  {
    id: "automerge-adapter-idb",
    source: `export { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";`,
    note: "automerge-repo IndexedDBStorageAdapter",
  },
];

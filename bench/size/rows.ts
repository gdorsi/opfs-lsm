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
    budget: 65_000,
  },
  {
    id: "docstore",
    kv: true,
    source: `export { defineSchema, openDocStore } from "@opfs-lsm/docstore"; export { openDb } from "@opfs-lsm/kv";`,
    note: "defineSchema, openDocStore and openDb, includes kv",
    budget: 57_000,
  },
  { id: "dexie", source: `export { default } from "dexie";`, note: "Dexie" },
  { id: "yjs", source: `export * as Y from "yjs";`, note: "yjs alone, to subtract from the two rows below" },
  {
    id: "yjs+kv",
    kv: true,
    source: `export { KvPersistence } from "@opfs-lsm/yjs"; export { openDb } from "@opfs-lsm/kv"; export * as Y from "yjs";`,
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
    source: `export { kvStorage } from "@opfs-lsm/automerge"; export { openDb } from "@opfs-lsm/kv";`,
    note: "automerge-repo storage adapter on kv, includes kv",
  },
  {
    id: "automerge-adapter-idb",
    source: `export { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";`,
    note: "automerge-repo IndexedDBStorageAdapter",
  },
];

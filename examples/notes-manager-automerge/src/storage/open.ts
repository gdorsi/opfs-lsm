import type { StorageAdapterInterface } from "@automerge/automerge-repo";
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";
import { kvStorage } from "@opfs-lsm/automerge";
import { openDb } from "@opfs-lsm/kv";

export type StorageKind = "kv" | "idb";

/** The list doc and every body in one database named `name`. The app keeps it open for the tab's life. */
export async function openStorage(kind: StorageKind, name: string): Promise<StorageAdapterInterface> {
  return kind === "idb" ? new IndexedDBStorageAdapter(name) : kvStorage(await openDb({ name }));
}

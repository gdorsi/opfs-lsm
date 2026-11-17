import type { StorageAdapterInterface } from "@automerge/automerge-repo";
import { kvStorage } from "@opfs-lsm/automerge";
import { openDb } from "@opfs-lsm/kv";

export async function openStorage(name: string): Promise<StorageAdapterInterface> {
  return kvStorage(await openDb({ name }));
}

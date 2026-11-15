import { openDb } from "@opfs-lsm/kv";
import type { PagesStorage } from "../model/types.ts";
import { indexedDbPagesStorage } from "./indexeddb.ts";
import { kvPagesStorage } from "./kv.ts";

/** `kv`: fate and the bodies share one kv db. `idb`: `<name>-fate` and `<name>-bodies` in IndexedDB. */
export type StorageKind = "kv" | "idb";

/** The only place the app picks a storage. */
export async function openPagesStorage(kind: StorageKind, name: string): Promise<PagesStorage> {
  return kind === "idb" ? indexedDbPagesStorage(name) : kvPagesStorage(await openDb({ name }));
}

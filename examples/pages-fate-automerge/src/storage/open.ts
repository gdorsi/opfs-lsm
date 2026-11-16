import { openDb } from "@opfs-lsm/kv";
import type { PagesStorage } from "../model/types.ts";
import { indexedDbPagesStorage } from "./indexeddb.ts";
import { kvPagesStorage } from "./kv.ts";

export type StorageKind = "kv" | "idb";

export async function openPagesStorage(kind: StorageKind, name: string): Promise<PagesStorage> {
  return kind === "idb" ? indexedDbPagesStorage(name) : kvPagesStorage(await openDb({ name }));
}

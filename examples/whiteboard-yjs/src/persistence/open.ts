import { openDb } from "@opfs-lsm/kv";
import type { DocStorage } from "../model/index.ts";
import { idbStorage } from "./idb.ts";
import { kvStorage } from "./kv.ts";

/**
 * The one place the app picks a backend. `name` is the kv db name or the IndexedDB prefix.
 * `close` is idempotent. For kv it closes the db, which the model never does, so the caller runs it after the workspace closed.
 */
export async function openStorage(
  kind: "kv" | "idb",
  name: string,
): Promise<{ readonly storage: DocStorage; close(): Promise<void> }> {
  if (kind === "idb") return { storage: idbStorage(name), close: async () => {} };
  const db = await openDb({ name });
  return { storage: kvStorage(db), close: () => db.close() };
}

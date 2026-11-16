import { openDb } from "@opfs-lsm/kv";
import type { DocStorage } from "../model/index.ts";
import { idbStorage } from "./idb.ts";
import { kvStorage } from "./kv.ts";

export async function openStorage(
  kind: "kv" | "idb",
  name: string,
): Promise<{ readonly storage: DocStorage; close(): Promise<void> }> {
  if (kind === "idb") return { storage: idbStorage(name), close: async () => {} };
  const db = await openDb({ name });
  return { storage: kvStorage(db), close: () => db.close() };
}

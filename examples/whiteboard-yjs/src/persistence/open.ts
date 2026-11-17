import { openDb } from "@opfs-lsm/kv";
import type { DocStorage } from "../model/index.ts";
import { kvStorage } from "./kv.ts";

export async function openStorage(name: string): Promise<{ readonly storage: DocStorage; close(): Promise<void> }> {
  const db = await openDb({ name });
  return { storage: kvStorage(db), close: () => db.close() };
}

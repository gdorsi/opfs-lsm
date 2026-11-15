import { kvStorage as kvBodies } from "@opfs-lsm/automerge";
import { kvStorage as kvFate } from "@opfs-lsm/fate";
import type { Db } from "@opfs-lsm/kv";
import type { PagesStorage } from "../model/types.ts";

/**
 * Both layers on one kv db: one SharedWorker, one WAL, one open. fate keys
 * start with 0x66 and automerge keys with a length frame, so the two never
 * collide. The caller opens and closes `db`.
 */
export function kvPagesStorage(db: Db): PagesStorage {
  return { fate: kvFate(db), bodies: kvBodies(db) };
}

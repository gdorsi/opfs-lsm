import type { Db } from "@opfs-lsm/kv";
import { KvPersistence } from "@opfs-lsm/yjs";
import type * as Y from "yjs";
import type { DocBinding, DocStorage } from "../model/index.ts";

/** Stores every doc in one kv `db`, as `KvPersistence` does. The caller owns the db and closes it. */
export function kvStorage(db: Db): DocStorage {
  return {
    async attach(docName: string, doc: Y.Doc): Promise<DocBinding> {
      const persistence = new KvPersistence(db, docName, doc);
      try {
        await persistence.whenSynced;
      } catch (error) {
        await persistence.destroy().catch(() => {});
        throw error;
      }
      return {
        flush: () => persistence.flush(),
        detach: () => persistence.destroy(),
        clear: () => persistence.clearData(),
      };
    },
  };
}

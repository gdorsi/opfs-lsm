import { DocStoreError, type JsonDoc } from "@opfs-lsm/docstore";
import type { ChangeMessageOrDeleteKeyMessage, PendingMutation, SyncConfig } from "@tanstack/db";
import type { DocstoreCollectionUtils } from "./index.js";

export function memoryParts<T extends JsonDoc>() {
  const rows = new Map<string, T>();
  const running = new Set<Parameters<SyncConfig<T, string>["sync"]>[0]>();

  const apply = (writes: ReadonlyMap<string, T | null>): void => {
    const messages: ChangeMessageOrDeleteKeyMessage<T, string>[] = [];
    for (const [id, doc] of writes) {
      if (doc) {
        rows.set(id, doc);
        messages.push({ type: "update", value: doc });
      } else if (rows.delete(id)) messages.push({ type: "delete", key: id });
    }
    if (messages.length === 0) return;
    for (const p of running) {
      p.begin();
      for (const message of messages) p.write(message);
      p.commit();
    }
  };

  const sync: SyncConfig<T, string>["sync"] = (params) => {
    running.add(params);
    params.begin({ snapshot: true });
    for (const doc of rows.values()) params.write({ type: "update", value: doc });
    params.commit();
    params.markReady();
    return { cleanup: () => void running.delete(params), loadSubset: () => true };
  };

  const persist = async (mutations: ReadonlyArray<PendingMutation<any>>): Promise<void> =>
    apply(new Map(mutations.map((m) => [String(m.key), m.type === "delete" ? null : (m.modified as T)])));

  const transact: DocstoreCollectionUtils<T>["transact"] = async (ids, merge) => {
    const next = merge(ids.map((id) => rows.get(id)));
    if (next.length !== ids.length) throw new DocStoreError("document", `merge must return one entry for each of the ${ids.length} ids`);
    const writes = new Map<string, T | null>();
    next.forEach((doc, i) => {
      if (doc === undefined) return;
      if (doc && doc.id !== ids[i]) throw new DocStoreError("document", `merge returned a document with id "${doc.id}" for "${ids[i]}"`);
      writes.set(ids[i]!, doc);
    });
    apply(writes);
  };

  return { sync, persist, transact };
}

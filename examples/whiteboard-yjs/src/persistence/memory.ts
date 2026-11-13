import * as Y from "yjs";
import type { DocBinding, DocStorage } from "../model/index.ts";

/** Keeps every update in memory. The Node test double of the storage seam. */
export function memoryStorage(): DocStorage & { readonly updates: ReadonlyMap<string, readonly Uint8Array[]> } {
  const updates = new Map<string, Uint8Array[]>();
  return {
    updates,
    async attach(docName: string, doc: Y.Doc): Promise<DocBinding> {
      const stored = updates.get(docName) ?? [];
      updates.set(docName, stored);
      const binding: DocBinding = {
        flush: async () => {},
        detach: async () => void doc.off("update", store),
        clear: async () => {
          doc.off("update", store);
          updates.delete(docName);
        },
      };
      const store = (update: Uint8Array) => void stored.push(update);
      Y.transact(doc, () => stored.forEach((update) => Y.applyUpdate(doc, update)), binding, false);
      doc.on("update", store);
      return binding;
    },
  };
}

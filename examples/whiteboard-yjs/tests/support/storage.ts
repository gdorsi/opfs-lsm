import * as Y from "yjs";
import type { DocBinding, DocStorage } from "../../src/model/index.ts";
import { memoryStorage } from "../../src/persistence/index.ts";

/** Stores like memoryStorage but silently drops every `every`th update. */
export function lossyStorage(every = 7): DocStorage {
  const updates = new Map<string, Uint8Array[]>();
  let seen = 0;
  return {
    async attach(docName: string, doc: Y.Doc): Promise<DocBinding> {
      const stored = updates.get(docName) ?? [];
      updates.set(docName, stored);
      const store = (update: Uint8Array) => {
        if (++seen % every !== 0) stored.push(update);
      };
      const binding: DocBinding = {
        flush: async () => {},
        detach: async () => void doc.off("update", store),
        clear: async () => void updates.delete(docName),
      };
      Y.transact(doc, () => stored.forEach((update) => Y.applyUpdate(doc, update)), binding, false);
      doc.on("update", store);
      return binding;
    },
  };
}

/** memoryStorage that also hands the tests the Y.Doc each attach received, to play another tab. */
export function spyStorage() {
  const inner = memoryStorage();
  const docs = new Map<string, Y.Doc>();
  const storage: DocStorage & typeof inner = {
    updates: inner.updates,
    attach(docName, doc) {
      docs.set(docName, doc);
      return inner.attach(docName, doc);
    },
  };
  return { storage, docs };
}

/** Two docs that see each other's updates from now on, like two tabs on one relay. */
export function link(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a), "link");
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b), "link");
  a.on("update", (update: Uint8Array, origin: unknown) => origin === "link" || Y.applyUpdate(b, update, "link"));
  b.on("update", (update: Uint8Array, origin: unknown) => origin === "link" || Y.applyUpdate(a, update, "link"));
}

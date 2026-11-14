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

/** memoryStorage whose flush rejects while `control.failing` is set, and counts every flush it is asked for. */
export function flakyStorage() {
  const inner = memoryStorage();
  const control = { failing: false, flushes: 0, hold: undefined as Promise<void> | undefined };
  const storage: DocStorage & typeof inner = {
    updates: inner.updates,
    async attach(docName, doc) {
      const binding = await inner.attach(docName, doc);
      return {
        ...binding,
        async flush() {
          control.flushes++;
          if (control.hold) await control.hold;
          if (control.failing) throw new Error("disk full");
          return binding.flush();
        },
      };
    },
  };
  return { storage, control };
}

/**
 * A disk that keeps an update only once it is flushed, and a process that can die. After `dieAfter(n)` completes n
 * storage operations (an update handed to storage, a flush, a clear, an attach), the process is dead: later calls
 * reject and later updates vanish. What was not flushed by then is lost. `restart()` is a new process on the same disk.
 */
export function crashDisk() {
  const disk = new Map<string, Uint8Array[]>();
  let budget = Infinity;
  let done = 0;
  let dead = false;
  const allowed = (): boolean => {
    if (!dead && done >= budget) dead = true;
    if (dead) return false;
    done++;
    return true;
  };
  const died = () => new Error("the process died");

  const storage: DocStorage = {
    async attach(docName, doc) {
      if (!allowed()) throw died();
      const queued: Uint8Array[] = [];
      const store = (update: Uint8Array) => void (allowed() && queued.push(update));
      const flush = async () => {
        if (!allowed()) throw died();
        disk.set(docName, [...(disk.get(docName) ?? []), ...queued.splice(0)]);
      };
      const binding: DocBinding = {
        flush,
        detach: async () => {
          await flush();
          doc.off("update", store);
        },
        clear: async () => {
          if (!allowed()) throw died();
          doc.off("update", store);
          queued.length = 0;
          disk.delete(docName);
        },
      };
      Y.transact(doc, () => (disk.get(docName) ?? []).forEach((update) => Y.applyUpdate(doc, update)), binding, false);
      doc.on("update", store);
      return binding;
    },
  };
  return {
    storage,
    /** The updates on disk for a doc, or undefined when it has none. */
    stored: (docName: string) => (disk.get(docName)?.length ? disk.get(docName) : undefined),
    dieAfter(operations: number) {
      budget = operations;
      done = 0;
      dead = false;
    },
    /** The operations completed since `dieAfter`, or since the start. */
    get operations() {
      return done;
    },
    restart() {
      budget = Infinity;
      done = 0;
      dead = false;
    },
  };
}

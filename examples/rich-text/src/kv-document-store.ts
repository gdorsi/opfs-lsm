import { openDb, type Db } from "@opfs-lsm/kv";

/**
 * A small persistence layer for rich-text documents, built directly on
 * `@opfs-lsm/kv`.
 *
 * - One `openDb` database (OPFS + shared WAL in the browser).
 * - Each document is stored as UTF-8 JSON under `doc:<docId>`.
 * - Writes are durable WAL appends (`db.put`); `db.changes()` notifies this
 *   tab when another tab commits, so editors can reload.
 */
export type StoredDocument = unknown;

export type DocumentStore = {
  readonly dbName: string;
  readonly docId: string;
  load(): Promise<StoredDocument | null>;
  save(doc: StoredDocument): Promise<void>;
  /** Fires when any writer (this tab or another) changes the database. */
  onChange(listener: () => void): () => void;
  sync(): Promise<void>;
  close(): Promise<void>;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

function docKey(docId: string): Uint8Array {
  return encoder.encode(`doc:${docId}`);
}

function encodeDoc(doc: StoredDocument): Uint8Array {
  return encoder.encode(JSON.stringify(doc));
}

function decodeDoc(bytes: Uint8Array): StoredDocument | null {
  try {
    return JSON.parse(decoder.decode(bytes)) as StoredDocument;
  } catch {
    return null;
  }
}

export async function openDocumentStore(opts: {
  dbName: string;
  docId: string;
}): Promise<DocumentStore> {
  const db: Db = await openDb({ name: opts.dbName });
  const key = docKey(opts.docId);

  return {
    dbName: opts.dbName,
    docId: opts.docId,

    async load() {
      const bytes = await db.get(key);
      return bytes ? decodeDoc(bytes) : null;
    },

    async save(doc) {
      await db.put(key, encodeDoc(doc));
    },

    onChange(listener) {
      return db.changes(listener);
    },

    sync() {
      return db.sync();
    },

    close() {
      return db.close();
    },
  };
}

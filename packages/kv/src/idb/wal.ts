import type { CheckedOp, DbName, WriterId } from "../check.js";
import { CommitError } from "../errors.js";

const WAL_STORE = "wal";
const META_STORE = "meta";
const META_INGESTED = "ingestedThrough";
/** Schema: autoIncrement WAL + single ingestedThrough cursor. */
const IDB_VERSION = 2;

export type WalRecord = {
  readonly seq: number;
  readonly writerId: WriterId;
  readonly ops: readonly CheckedOp[];
};

function idbName(dbName: DbName): string {
  return `opfs-lsm-wal/${dbName}`;
}

function openIdb(dbName: DbName): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(idbName(dbName), IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (db.objectStoreNames.contains(WAL_STORE)) {
        db.deleteObjectStore(WAL_STORE);
      }
      if (db.objectStoreNames.contains(META_STORE)) {
        db.deleteObjectStore(META_STORE);
      }
      db.createObjectStore(WAL_STORE, { autoIncrement: true });
      db.createObjectStore(META_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new CommitError("idb open failed"));
  });
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new CommitError("idb request failed"));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new CommitError("idb tx failed"));
    tx.onabort = () => reject(tx.error ?? new CommitError("idb tx aborted"));
  });
}

function encodeOps(ops: readonly CheckedOp[]): unknown {
  return ops.map((op) => {
    if (op.type === "put") {
      return {
        type: "put",
        key: op.key.buffer.slice(
          op.key.byteOffset,
          op.key.byteOffset + op.key.byteLength,
        ),
        value: op.value.buffer.slice(
          op.value.byteOffset,
          op.value.byteOffset + op.value.byteLength,
        ),
      };
    }
    return {
      type: "del",
      key: op.key.buffer.slice(
        op.key.byteOffset,
        op.key.byteOffset + op.key.byteLength,
      ),
    };
  });
}

function decodeOps(raw: unknown): CheckedOp[] {
  if (!Array.isArray(raw)) throw new CommitError("corrupt wal ops");
  return raw.map((item) => {
    const row = item as {
      type: string;
      key: ArrayBuffer;
      value?: ArrayBuffer;
    };
    const key = new Uint8Array(row.key) as CheckedOp["key"];
    if (row.type === "put") {
      if (!row.value) throw new CommitError("corrupt wal put");
      return {
        type: "put" as const,
        key,
        value: new Uint8Array(row.value) as Extract<
          CheckedOp,
          { type: "put" }
        >["value"],
      };
    }
    if (row.type === "del") {
      return { type: "del" as const, key };
    }
    throw new CommitError(`unknown wal op ${row.type}`);
  });
}

/**
 * One shared IDB WAL for every tab of a database name.
 * Keys are autoIncrement seqs — no per-tab nextSeq coordination.
 * Ack = transaction complete; other tabs see rows on their next read.
 */
export class IdBWal {
  private constructor(
    readonly dbName: DbName,
    private readonly db: IDBDatabase,
  ) {}

  static async open(dbName: DbName): Promise<IdBWal> {
    const db = await openIdb(dbName);
    return new IdBWal(dbName, db);
  }

  close(): void {
    this.db.close();
  }

  async getIngestedThrough(): Promise<number> {
    const tx = this.db.transaction(META_STORE, "readonly");
    const store = tx.objectStore(META_STORE);
    const raw = await reqToPromise(store.get(META_INGESTED));
    await txDone(tx);
    return typeof raw === "number" ? raw : 0;
  }

  /**
   * Append one batch. Seq assigned by IDB autoIncrement.
   * Returns the assigned seq.
   */
  async append(writerId: WriterId, ops: readonly CheckedOp[]): Promise<number> {
    const tx = this.db.transaction(WAL_STORE, "readwrite");
    const wal = tx.objectStore(WAL_STORE);
    const key = await reqToPromise(
      wal.add({
        writerId,
        ops: encodeOps(ops),
      }),
    );
    await txDone(tx);
    if (typeof key !== "number") {
      throw new CommitError("wal autoIncrement key was not a number");
    }
    return key;
  }

  /** Highest autoIncrement seq currently in the WAL store, or 0 if empty. */
  async headSeq(): Promise<number> {
    const tx = this.db.transaction(WAL_STORE, "readonly");
    const store = tx.objectStore(WAL_STORE);
    const head = await new Promise<number>((resolve, reject) => {
      const req = store.openCursor(null, "prev");
      req.onerror = () => reject(req.error ?? new CommitError("cursor failed"));
      req.onsuccess = () => {
        const cursor = req.result;
        resolve(cursor ? (cursor.key as number) : 0);
      };
    });
    await txDone(tx);
    return head;
  }

  /** All records with seq > ingestedThrough, ascending. */
  async listUningested(): Promise<WalRecord[]> {
    const through = await this.getIngestedThrough();
    return this.listRange(through + 1, Number.MAX_SAFE_INTEGER);
  }

  async listRange(
    fromSeqInclusive: number,
    toSeqInclusive: number,
  ): Promise<WalRecord[]> {
    const tx = this.db.transaction(WAL_STORE, "readonly");
    const store = tx.objectStore(WAL_STORE);
    const range = IDBKeyRange.bound(fromSeqInclusive, toSeqInclusive);
    const out: WalRecord[] = [];
    await new Promise<void>((resolve, reject) => {
      const req = store.openCursor(range);
      req.onerror = () => reject(req.error ?? new CommitError("cursor failed"));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve();
          return;
        }
        const seq = cursor.key as number;
        const value = cursor.value as { writerId: string; ops: unknown };
        out.push({
          seq,
          writerId: value.writerId as WriterId,
          ops: decodeOps(value.ops),
        });
        cursor.continue();
      };
    });
    await txDone(tx);
    return out;
  }

  /**
   * Mark seqs <= through as ingested and delete those WAL rows.
   */
  async advanceIngested(through: number): Promise<void> {
    const tx = this.db.transaction([WAL_STORE, META_STORE], "readwrite");
    const wal = tx.objectStore(WAL_STORE);
    const metaStore = tx.objectStore(META_STORE);
    const existingRaw = await reqToPromise(metaStore.get(META_INGESTED));
    const existing = typeof existingRaw === "number" ? existingRaw : 0;
    if (through < existing) {
      await txDone(tx);
      return;
    }
    const range = IDBKeyRange.bound(existing + 1, through);
    await new Promise<void>((resolve, reject) => {
      const req = wal.openCursor(range);
      req.onerror = () => reject(req.error ?? new CommitError("cursor failed"));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve();
          return;
        }
        cursor.delete();
        cursor.continue();
      };
    });
    await reqToPromise(metaStore.put(through, META_INGESTED));
    await txDone(tx);
  }
}

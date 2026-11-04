import type { CheckedOp, DbName, WriterId } from "../check.js";
import { CommitError } from "../errors.js";
import type { ScanBounds } from "../store/cursor.js";

const WAL_STORE = "wal";
const META_STORE = "meta";
const MEM_STORE = "mem";
const META_INGESTED = "ingestedThrough";
/**
 * Schema v3: autoIncrement WAL + ingestedThrough + key-ordered memtable.
 * v2 databases keep wal and meta; upgrade backfills mem from the uningested tail.
 */
const IDB_VERSION = 3;

export type WalRecord = {
  readonly seq: number;
  readonly writerId: WriterId;
  readonly ops: readonly CheckedOp[];
};

/** One latest op per user key. The primary key is the user key, not stored here. */
export type MemRow = {
  readonly key: Uint8Array;
  readonly seq: number;
  readonly kind: "put" | "del";
  readonly value?: Uint8Array;
};

/** Consistent picture from one readonly transaction. */
export type MemPin = {
  readonly head: number;
  readonly ingestedThrough: number;
  readonly rows: readonly MemRow[];
};

type StoredMem = {
  seq: number;
  kind: "put" | "del";
  value?: ArrayBuffer;
};

function idbName(dbName: DbName): string {
  return `opfs-lsm-wal/${dbName}`;
}

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer as ArrayBuffer;
}

function storedFromOp(op: CheckedOp, seq: number): StoredMem {
  if (op.type === "put") {
    return { seq, kind: "put", value: bufferOf(op.value) };
  }
  return { seq, kind: "del" };
}

function binaryKey(key: IDBValidKey): Uint8Array {
  if (key instanceof ArrayBuffer) return new Uint8Array(key);
  if (key instanceof Uint8Array) return new Uint8Array(key);
  throw new CommitError("mem key was not binary");
}

function memRowFrom(key: IDBValidKey, raw: unknown): MemRow {
  const row = raw as StoredMem;
  if (row.kind === "put") {
    if (!row.value) throw new CommitError("corrupt mem put");
    return {
      key: binaryKey(key),
      seq: row.seq,
      kind: "put",
      value: new Uint8Array(row.value),
    };
  }
  return { key: binaryKey(key), seq: row.seq, kind: "del" };
}

function memKeyRange(bounds?: ScanBounds): IDBKeyRange | null {
  const start = bounds?.start ? bufferOf(bounds.start) : undefined;
  const end = bounds?.endExclusive ? bufferOf(bounds.endExclusive) : undefined;
  if (start && end) return IDBKeyRange.bound(start, end, false, true);
  if (start) return IDBKeyRange.lowerBound(start);
  if (end) return IDBKeyRange.upperBound(end, true);
  return null;
}

function backfillMem(tx: IDBTransaction): void {
  const wal = tx.objectStore(WAL_STORE);
  const meta = tx.objectStore(META_STORE);
  const mem = tx.objectStore(MEM_STORE);
  const metaReq = meta.get(META_INGESTED);
  metaReq.onsuccess = () => {
    const through = typeof metaReq.result === "number" ? metaReq.result : 0;
    const curReq = wal.openCursor(IDBKeyRange.lowerBound(through, true));
    curReq.onsuccess = () => {
      const cursor = curReq.result;
      if (!cursor) return;
      const seq = cursor.key as number;
      const value = cursor.value as { ops: unknown };
      for (const op of decodeOps(value.ops)) {
        mem.put(storedFromOp(op, seq), bufferOf(op.key));
      }
      cursor.continue();
    };
  };
}

function openIdb(dbName: DbName): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(idbName(dbName), IDB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      const tx = req.transaction;
      if (!tx) throw new CommitError("missing upgrade transaction");
      const oldVersion = ev.oldVersion;
      if (oldVersion > 0 && oldVersion < 2) {
        if (db.objectStoreNames.contains(WAL_STORE)) {
          db.deleteObjectStore(WAL_STORE);
        }
        if (db.objectStoreNames.contains(META_STORE)) {
          db.deleteObjectStore(META_STORE);
        }
      }
      if (!db.objectStoreNames.contains(WAL_STORE)) {
        db.createObjectStore(WAL_STORE, { autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE);
      }
      if (!db.objectStoreNames.contains(MEM_STORE)) {
        db.createObjectStore(MEM_STORE);
      }
      if (oldVersion >= 2 && oldVersion < 3) backfillMem(tx);
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

function readHead(store: IDBObjectStore): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = store.openCursor(null, "prev");
    req.onerror = () => reject(req.error ?? new CommitError("cursor failed"));
    req.onsuccess = () => {
      const cursor = req.result;
      resolve(cursor ? (cursor.key as number) : 0);
    };
  });
}

function drainMem(
  store: IDBObjectStore,
  bounds?: ScanBounds,
): Promise<MemRow[]> {
  const out: MemRow[] = [];
  return new Promise((resolve, reject) => {
    const req = store.openCursor(memKeyRange(bounds));
    req.onerror = () => reject(req.error ?? new CommitError("cursor failed"));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve(out);
        return;
      }
      out.push(memRowFrom(cursor.key, cursor.value));
      cursor.continue();
    };
  });
}

function deleteMemThrough(
  mem: IDBObjectStore,
  through: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = mem.openCursor();
    req.onerror = () => reject(req.error ?? new CommitError("cursor failed"));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve();
        return;
      }
      const row = cursor.value as StoredMem;
      if (typeof row.seq === "number" && row.seq <= through) cursor.delete();
      cursor.continue();
    };
  });
}

/**
 * One shared IDB database for every tab of a database name.
 * `wal` is the seq log (OCC, ingest cursor). `mem` is one row per user key,
 * upserted in the same transaction as the append. Ack = transaction complete.
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
   * Each op upserts `mem` under the user key in this same transaction.
   * A repeated key in the batch keeps the later op.
   */
  async append(writerId: WriterId, ops: readonly CheckedOp[]): Promise<number> {
    const tx = this.db.transaction([WAL_STORE, MEM_STORE], "readwrite");
    const wal = tx.objectStore(WAL_STORE);
    const mem = tx.objectStore(MEM_STORE);
    const key = await reqToPromise(
      wal.add({
        writerId,
        ops: encodeOps(ops),
      }),
    );
    if (typeof key !== "number") {
      throw new CommitError("wal autoIncrement key was not a number");
    }
    for (const op of ops) {
      mem.put(storedFromOp(op, key), bufferOf(op.key));
    }
    await txDone(tx);
    return key;
  }

  /** Primary-key read of the uningested cell for `key`. */
  async memGet(key: Uint8Array): Promise<MemRow | undefined> {
    const tx = this.db.transaction(MEM_STORE, "readonly");
    const store = tx.objectStore(MEM_STORE);
    const raw = await reqToPromise(store.get(bufferOf(key)));
    await txDone(tx);
    if (raw === undefined) return undefined;
    return memRowFrom(bufferOf(key), raw);
  }

  /**
   * One readonly transaction: WAL head, ingestedThrough, and mem rows in key order.
   * `bounds` restricts the mem cursor. Head and ingestedThrough are global.
   * The requests are issued in one turn so they share a snapshot.
   */
  async collectMem(bounds?: ScanBounds): Promise<MemPin> {
    const tx = this.db.transaction(
      [WAL_STORE, META_STORE, MEM_STORE],
      "readonly",
    );
    const headP = readHead(tx.objectStore(WAL_STORE));
    const ingestedP = reqToPromise(
      tx.objectStore(META_STORE).get(META_INGESTED),
    );
    const rowsP = drainMem(tx.objectStore(MEM_STORE), bounds);
    const [head, ingestedRaw, rows] = await Promise.all([
      headP,
      ingestedP,
      rowsP,
    ]);
    await txDone(tx);
    return {
      head,
      ingestedThrough: typeof ingestedRaw === "number" ? ingestedRaw : 0,
      rows,
    };
  }

  /** Highest autoIncrement seq currently in the WAL store, or 0 if empty. */
  async headSeq(): Promise<number> {
    const tx = this.db.transaction(WAL_STORE, "readonly");
    const head = await readHead(tx.objectStore(WAL_STORE));
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
   * Mark seqs <= through as ingested, delete those WAL rows, and delete mem
   * rows whose stored seq is still <= through. A row rewritten to a higher
   * seq stays.
   */
  async advanceIngested(through: number): Promise<void> {
    const tx = this.db.transaction(
      [WAL_STORE, META_STORE, MEM_STORE],
      "readwrite",
    );
    const wal = tx.objectStore(WAL_STORE);
    const metaStore = tx.objectStore(META_STORE);
    const mem = tx.objectStore(MEM_STORE);
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
    await deleteMemThrough(mem, through);
    await reqToPromise(metaStore.put(through, META_INGESTED));
    await txDone(tx);
  }
}

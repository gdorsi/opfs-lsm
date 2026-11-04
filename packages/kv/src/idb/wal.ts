import { keyToString } from "../bytes.js";
import type { CheckedOp, DbName, WriterId } from "../check.js";
import { CommitError, ConflictError } from "../errors.js";
import type { ScanBounds } from "../store/cursor.js";

const WAL_STORE = "wal";
const META_STORE = "meta";
const MEM_STORE = "mem";
const META_INGESTED = "ingestedThrough";
/** The OPFS generation whose runs hold every seq <= ingestedThrough. */
const META_GENERATION = "generation";
/**
 * Highest WAL seq deleted. Rows above it stay until they are ingested and
 * older than WAL_RETAIN_MS, so a transaction can still check them for conflicts.
 */
const META_FLOOR = "walFloor";
const WAL_RETAIN_MS = 10_000;
/**
 * Schema v3: autoIncrement WAL + ingestedThrough + key-ordered memtable.
 * v2 databases keep wal and meta; upgrade backfills mem from the uningested tail.
 * Schema v4 adds meta.generation. The bump shuts out v3 code, which truncates
 * mem without recording the generation that holds those rows.
 */
const IDB_VERSION = 4;

/** Commit only if no WAL record after `snapshotHead` touches a watched key. */
export type AppendGuard = {
  readonly snapshotHead: number;
  readonly watched: ReadonlySet<string>;
};

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
  readonly generation: number;
  readonly rows: readonly MemRow[];
};

/** One mem row and the generation that covers what mem no longer holds. */
export type MemPoint = {
  readonly row: MemRow | undefined;
  readonly generation: number;
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
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new CommitError("idb open failed"));
  });
}

/** A database made before the floor was recorded deleted every ingested row. */
async function readFloor(meta: IDBObjectStore): Promise<number> {
  const floor = await reqToPromise(meta.get(META_FLOOR));
  if (typeof floor === "number") return floor;
  const ingested = await reqToPromise(meta.get(META_INGESTED));
  return typeof ingested === "number" ? ingested : 0;
}

function generationOf(raw: unknown): number {
  return typeof raw === "number" ? raw : 0;
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

function touchesWatched(
  wal: IDBObjectStore,
  guard: AppendGuard,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const req = wal.openCursor(IDBKeyRange.lowerBound(guard.snapshotHead, true));
    req.onerror = () => reject(req.error ?? new CommitError("cursor failed"));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve(false);
        return;
      }
      const value = cursor.value as { ops: unknown };
      for (const op of decodeOps(value.ops)) {
        if (guard.watched.has(keyToString(op.key))) {
          resolve(true);
          return;
        }
      }
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
   * With `guard`, the conflict scan runs in this readwrite transaction, so no
   * other append can land between the scan and the add.
   */
  async append(
    writerId: WriterId,
    ops: readonly CheckedOp[],
    guard?: AppendGuard,
  ): Promise<number> {
    const tx = this.db.transaction(
      [WAL_STORE, MEM_STORE, META_STORE],
      "readwrite",
    );
    const wal = tx.objectStore(WAL_STORE);
    const mem = tx.objectStore(MEM_STORE);
    if (guard) {
      const floor = await readFloor(tx.objectStore(META_STORE));
      if (guard.snapshotHead < floor || (await touchesWatched(wal, guard))) {
        tx.abort();
        throw new ConflictError(
          guard.snapshotHead < floor
            ? `wal rows after seq ${guard.snapshotHead} were already deleted`
            : `conflict on key after wal seq ${guard.snapshotHead}`,
        );
      }
    }
    const key = await reqToPromise(
      wal.add({
        writerId,
        at: Date.now(),
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

  /** The uningested cell for `key` and the generation, from one readonly transaction. */
  async memGet(key: Uint8Array): Promise<MemPoint> {
    const tx = this.db.transaction([MEM_STORE, META_STORE], "readonly");
    const rawP = reqToPromise(tx.objectStore(MEM_STORE).get(bufferOf(key)));
    const genP = reqToPromise(tx.objectStore(META_STORE).get(META_GENERATION));
    const [raw, gen] = await Promise.all([rawP, genP]);
    await txDone(tx);
    return {
      row: raw === undefined ? undefined : memRowFrom(bufferOf(key), raw),
      generation: generationOf(gen),
    };
  }

  /** The recorded generation. Undefined for a database made before it was recorded. */
  async recordedGeneration(): Promise<number | undefined> {
    const tx = this.db.transaction(META_STORE, "readonly");
    const raw = await reqToPromise(tx.objectStore(META_STORE).get(META_GENERATION));
    await txDone(tx);
    return typeof raw === "number" ? raw : undefined;
  }

  /** Record `generation` unless a newer one is already recorded. */
  async raiseGeneration(generation: number): Promise<void> {
    const tx = this.db.transaction(META_STORE, "readwrite");
    const meta = tx.objectStore(META_STORE);
    const raw = await reqToPromise(meta.get(META_GENERATION));
    if (typeof raw !== "number" || generation > raw) {
      meta.put(Math.max(generationOf(raw), generation), META_GENERATION);
    }
    await txDone(tx);
  }

  /**
   * One readonly transaction: WAL head, generation, and mem rows in key order.
   * `bounds` restricts the mem cursor. Head and generation are global.
   * The requests are issued in one turn so they share a snapshot.
   */
  async collectMem(bounds?: ScanBounds): Promise<MemPin> {
    const tx = this.db.transaction(
      [WAL_STORE, META_STORE, MEM_STORE],
      "readonly",
    );
    const headP = readHead(tx.objectStore(WAL_STORE));
    const genP = reqToPromise(
      tx.objectStore(META_STORE).get(META_GENERATION),
    );
    const rowsP = drainMem(tx.objectStore(MEM_STORE), bounds);
    const [head, gen, rows] = await Promise.all([headP, genP, rowsP]);
    await txDone(tx);
    return { head, generation: generationOf(gen), rows };
  }

  /**
   * Transaction snapshot: the WAL head, or the floor when every row up to it
   * was deleted. Every seq at or below the result is already applied.
   */
  async snapshotHead(): Promise<number> {
    const tx = this.db.transaction([WAL_STORE, META_STORE], "readonly");
    const [head, floor] = await Promise.all([
      readHead(tx.objectStore(WAL_STORE)),
      readFloor(tx.objectStore(META_STORE)),
    ]);
    await txDone(tx);
    return Math.max(head, floor);
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
   * seq stays. `generation` is recorded in the same transaction, so a reader
   * never sees truncated mem paired with a generation that lacks those rows.
   */
  async advanceIngested(through: number, generation: number): Promise<void> {
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
    const cutoff = Date.now() - WAL_RETAIN_MS;
    const prevFloor = await readFloor(metaStore);
    const floor = await new Promise<number>((resolve, reject) => {
      let deleted = prevFloor;
      const req = wal.openCursor(IDBKeyRange.upperBound(through));
      req.onerror = () => reject(req.error ?? new CommitError("cursor failed"));
      req.onsuccess = () => {
        const cursor = req.result;
        const at = (cursor?.value as { at?: unknown } | undefined)?.at;
        if (!cursor || (typeof at === "number" && at >= cutoff)) {
          resolve(deleted);
          return;
        }
        deleted = cursor.key as number;
        cursor.delete();
        cursor.continue();
      };
    });
    await reqToPromise(metaStore.put(floor, META_FLOOR));
    await deleteMemThrough(mem, through);
    await reqToPromise(metaStore.put(through, META_INGESTED));
    const cur = generationOf(await reqToPromise(metaStore.get(META_GENERATION)));
    await reqToPromise(
      metaStore.put(Math.max(cur, generation), META_GENERATION),
    );
    await txDone(tx);
  }
}

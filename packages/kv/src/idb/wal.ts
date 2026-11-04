import { compareBytes } from "../bytes.js";
import type { CheckedOp, DbName } from "../check.js";
import { CommitError, ConflictError } from "../errors.js";
import type { ScanBounds } from "../store/cursor.js";
import type { SstEntry } from "../store/sst.js";

/**
 * The log: one row per user key holding its latest op and the seq that wrote
 * it. The `bySeq` index orders the same rows by seq, for ingest and for
 * deleting ingested rows.
 */
const LOG_STORE = "mem";
const BY_SEQ = "bySeq";
const META_STORE = "meta";
/** Seq of the last committed batch. Every op in a batch shares its seq. */
const META_HEAD = "head";
const META_INGESTED = "ingestedThrough";
/** The OPFS generation whose runs hold every seq <= ingestedThrough. */
const META_GENERATION = "generation";
/**
 * Highest seq whose rows were deleted. Ingested rows stay until they are
 * older than LOG_RETAIN_MS, so a transaction can still check them for conflicts.
 */
const META_FLOOR = "walFloor";
const LOG_RETAIN_MS = 10_000;
/** The v4 and older append log. Schema v5 folds it into the log and drops it. */
const LEGACY_WAL_STORE = "wal";
const IDB_VERSION = 5;

/** Commit only if no watched key was written after `snapshotHead`. */
export type AppendGuard = {
  readonly snapshotHead: number;
  readonly watched: readonly Uint8Array[];
};

/** One latest op per user key. */
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

/** One log row and the generation that covers what the log no longer holds. */
export type MemPoint = {
  readonly row: MemRow | undefined;
  readonly generation: number;
};

/** Rows to fold into one L0, in key order, and the seq range they span. */
export type Uningested = {
  readonly first: number;
  readonly last: number;
  readonly entries: readonly SstEntry[];
};

type StoredRow = {
  seq: number;
  kind: "put" | "del";
  value?: ArrayBuffer;
  at: number;
};

function idbName(dbName: DbName): string {
  return `opfs-lsm-wal/${dbName}`;
}

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer as ArrayBuffer;
}

function storedFromOp(op: CheckedOp, seq: number, at: number): StoredRow {
  if (op.type === "put") {
    return { seq, kind: "put", value: bufferOf(op.value), at };
  }
  return { seq, kind: "del", at };
}

function binaryKey(key: IDBValidKey): Uint8Array {
  if (key instanceof ArrayBuffer) return new Uint8Array(key);
  if (key instanceof Uint8Array) return new Uint8Array(key);
  throw new CommitError("log key was not binary");
}

function memRowFrom(key: IDBValidKey, raw: unknown): MemRow {
  const row = raw as StoredRow;
  if (row.kind === "put") {
    if (!row.value) throw new CommitError("corrupt log put");
    return {
      key: binaryKey(key),
      seq: row.seq,
      kind: "put",
      value: new Uint8Array(row.value),
    };
  }
  return { key: binaryKey(key), seq: row.seq, kind: "del" };
}

function keyRange(bounds?: ScanBounds): IDBKeyRange | null {
  const start = bounds?.start ? bufferOf(bounds.start) : undefined;
  const end = bounds?.endExclusive ? bufferOf(bounds.endExclusive) : undefined;
  if (start && end) return IDBKeyRange.bound(start, end, false, true);
  if (start) return IDBKeyRange.lowerBound(start);
  if (end) return IDBKeyRange.upperBound(end, true);
  return null;
}

function num(raw: unknown): number {
  return typeof raw === "number" ? raw : 0;
}

/**
 * Fold the legacy WAL's uningested tail into the log, then drop the WAL.
 * Head and floor start at the old WAL head, so no transaction from before
 * the upgrade can commit against rows the fold dropped.
 */
function migrateLegacyWal(tx: IDBTransaction): void {
  const wal = tx.objectStore(LEGACY_WAL_STORE);
  const meta = tx.objectStore(META_STORE);
  const log = tx.objectStore(LOG_STORE);
  const ingestedReq = meta.get(META_INGESTED);
  ingestedReq.onsuccess = () => {
    let head = num(ingestedReq.result);
    const cur = wal.openCursor(IDBKeyRange.lowerBound(head, true));
    cur.onsuccess = () => {
      const cursor = cur.result;
      if (!cursor) {
        meta.put(head, META_HEAD);
        meta.put(head, META_FLOOR);
        tx.db.deleteObjectStore(LEGACY_WAL_STORE);
        return;
      }
      head = cursor.key as number;
      const ops = (cursor.value as { ops: unknown }).ops;
      for (const op of decodeLegacyOps(ops)) {
        log.put(storedFromOp(op, head, 0), bufferOf(op.key));
      }
      cursor.continue();
    };
  };
}

function decodeLegacyOps(raw: unknown): CheckedOp[] {
  if (!Array.isArray(raw)) throw new CommitError("corrupt wal ops");
  return raw.map((item) => {
    const row = item as { type: string; key: ArrayBuffer; value?: ArrayBuffer };
    const key = new Uint8Array(row.key) as CheckedOp["key"];
    if (row.type === "put" && row.value) {
      const value = new Uint8Array(row.value) as Extract<
        CheckedOp,
        { type: "put" }
      >["value"];
      return { type: "put" as const, key, value };
    }
    if (row.type === "del") return { type: "del" as const, key };
    throw new CommitError(`corrupt wal op ${row.type}`);
  });
}

function openIdb(dbName: DbName): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(idbName(dbName), IDB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      const tx = req.transaction;
      if (!tx) throw new CommitError("missing upgrade transaction");
      if (ev.oldVersion > 0 && ev.oldVersion < 2) {
        for (const name of [...db.objectStoreNames]) db.deleteObjectStore(name);
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE);
      }
      const log = db.objectStoreNames.contains(LOG_STORE)
        ? tx.objectStore(LOG_STORE)
        : db.createObjectStore(LOG_STORE);
      if (!log.indexNames.contains(BY_SEQ)) log.createIndex(BY_SEQ, "seq");
      if (db.objectStoreNames.contains(LEGACY_WAL_STORE)) migrateLegacyWal(tx);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
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

function drainLog(
  store: IDBObjectStore,
  bounds?: ScanBounds,
): Promise<MemRow[]> {
  const out: MemRow[] = [];
  return new Promise((resolve, reject) => {
    const req = store.openCursor(keyRange(bounds));
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

async function writtenAfter(
  log: IDBObjectStore,
  guard: AppendGuard,
): Promise<boolean> {
  const rows = await Promise.all(
    guard.watched.map((key) => reqToPromise(log.get(bufferOf(key)))),
  );
  return rows.some(
    (raw) => raw !== undefined && (raw as StoredRow).seq > guard.snapshotHead,
  );
}

/**
 * One shared IDB database for every tab of a database name. The log is the
 * write-ahead log and the memtable at once. Ack = transaction complete.
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
    const raw = await reqToPromise(tx.objectStore(META_STORE).get(META_INGESTED));
    await txDone(tx);
    return num(raw);
  }

  /**
   * Write one batch under the next seq. A repeated key keeps the later op.
   * With `guard`, the conflict check runs in this readwrite transaction, so
   * no other write can land between the check and the commit.
   */
  async append(ops: readonly CheckedOp[], guard?: AppendGuard): Promise<number> {
    const tx = this.db.transaction([LOG_STORE, META_STORE], "readwrite");
    const log = tx.objectStore(LOG_STORE);
    const meta = tx.objectStore(META_STORE);
    const [head, floor] = await Promise.all([
      reqToPromise(meta.get(META_HEAD)).then(num),
      reqToPromise(meta.get(META_FLOOR)).then(num),
    ]);
    if (guard) {
      const tooOld = guard.snapshotHead < floor;
      if (tooOld || (await writtenAfter(log, guard))) {
        tx.abort();
        throw new ConflictError(
          tooOld
            ? `log rows after seq ${guard.snapshotHead} were already deleted`
            : `conflict on key after seq ${guard.snapshotHead}`,
        );
      }
    }
    const seq = head + 1;
    const at = Date.now();
    for (const op of ops) log.put(storedFromOp(op, seq, at), bufferOf(op.key));
    meta.put(seq, META_HEAD);
    await txDone(tx);
    return seq;
  }

  /** The log row for `key` and the generation, from one readonly transaction. */
  async memGet(key: Uint8Array): Promise<MemPoint> {
    const tx = this.db.transaction([LOG_STORE, META_STORE], "readonly");
    const [raw, gen] = await Promise.all([
      reqToPromise(tx.objectStore(LOG_STORE).get(bufferOf(key))),
      reqToPromise(tx.objectStore(META_STORE).get(META_GENERATION)),
    ]);
    await txDone(tx);
    return {
      row: raw === undefined ? undefined : memRowFrom(bufferOf(key), raw),
      generation: num(gen),
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
      meta.put(Math.max(num(raw), generation), META_GENERATION);
    }
    await txDone(tx);
  }

  /** Seq of the last committed batch. Every seq at or below it is applied. */
  async snapshotHead(): Promise<number> {
    const tx = this.db.transaction(META_STORE, "readonly");
    const head = await reqToPromise(tx.objectStore(META_STORE).get(META_HEAD));
    await txDone(tx);
    return num(head);
  }

  /**
   * One readonly transaction: head, generation, and log rows in key order.
   * `bounds` restricts the rows. Head and generation are global.
   */
  async collectMem(bounds?: ScanBounds): Promise<MemPin> {
    const tx = this.db.transaction([LOG_STORE, META_STORE], "readonly");
    const meta = tx.objectStore(META_STORE);
    const [head, gen, rows] = await Promise.all([
      reqToPromise(meta.get(META_HEAD)),
      reqToPromise(meta.get(META_GENERATION)),
      drainLog(tx.objectStore(LOG_STORE), bounds),
    ]);
    await txDone(tx);
    return { head: num(head), generation: num(gen), rows };
  }

  /** Rows written after ingestedThrough, from one readonly transaction. */
  async listUningested(): Promise<Uningested | undefined> {
    const tx = this.db.transaction([LOG_STORE, META_STORE], "readonly");
    const through = num(
      await reqToPromise(tx.objectStore(META_STORE).get(META_INGESTED)),
    );
    const rows: MemRow[] = [];
    await new Promise<void>((resolve, reject) => {
      const req = tx
        .objectStore(LOG_STORE)
        .index(BY_SEQ)
        .openCursor(IDBKeyRange.lowerBound(through, true));
      req.onerror = () => reject(req.error ?? new CommitError("cursor failed"));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve();
          return;
        }
        rows.push(memRowFrom(cursor.primaryKey, cursor.value));
        cursor.continue();
      };
    });
    await txDone(tx);
    if (rows.length === 0) return undefined;
    const first = rows[0]!.seq;
    const last = rows[rows.length - 1]!.seq;
    rows.sort((a, b) => compareBytes(a.key, b.key));
    const entries = rows.map((row): SstEntry =>
      row.kind === "put"
        ? { kind: "put", key: row.key, value: row.value! }
        : { kind: "del", key: row.key },
    );
    return { first, last, entries };
  }

  /**
   * Mark seqs <= through as ingested and record `generation` in the same
   * transaction, so a reader never pairs a missing row with a generation that
   * lacks it. Ingested rows older than LOG_RETAIN_MS are deleted in seq order,
   * and the floor moves to the highest deleted seq.
   */
  async advanceIngested(through: number, generation: number): Promise<void> {
    const tx = this.db.transaction([LOG_STORE, META_STORE], "readwrite");
    const meta = tx.objectStore(META_STORE);
    const [existing, prevFloor, prevGen] = await Promise.all([
      reqToPromise(meta.get(META_INGESTED)).then(num),
      reqToPromise(meta.get(META_FLOOR)).then(num),
      reqToPromise(meta.get(META_GENERATION)).then(num),
    ]);
    if (through < existing) {
      await txDone(tx);
      return;
    }
    const cutoff = Date.now() - LOG_RETAIN_MS;
    const floor = await new Promise<number>((resolve, reject) => {
      let deleted = prevFloor;
      const req = tx
        .objectStore(LOG_STORE)
        .index(BY_SEQ)
        .openCursor(IDBKeyRange.upperBound(through));
      req.onerror = () => reject(req.error ?? new CommitError("cursor failed"));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor || (cursor.value as StoredRow).at >= cutoff) {
          resolve(deleted);
          return;
        }
        deleted = Math.max(deleted, (cursor.value as StoredRow).seq);
        cursor.delete();
        cursor.continue();
      };
    });
    meta.put(through, META_INGESTED);
    meta.put(floor, META_FLOOR);
    meta.put(Math.max(prevGen, generation), META_GENERATION);
    await txDone(tx);
  }
}

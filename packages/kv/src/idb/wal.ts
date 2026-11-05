import type { CheckedOp, DbName } from "../check.js";
import { CommitError } from "../errors.js";
import type { WalRecord } from "../store/memtable.js";

/** One record per batch, keyed by seq. Holds only seqs above ingestedThrough. */
const WAL_STORE = "wal";
const META_STORE = "meta";
/** Seq of the last committed batch. */
const META_HEAD = "head";
const META_INGESTED = "ingestedThrough";
/** The OPFS generation whose runs hold every seq <= ingestedThrough. */
const META_GENERATION = "generation";
/** The v5 key-ordered log. Schema v6 rebuilds the WAL from it and drops it. */
const LEGACY_MEM_STORE = "mem";
const IDB_VERSION = 6;

/** What a tab needs to bring its memtable up to the WAL head. */
export type WalTail = {
  readonly head: number;
  readonly generation: number;
  readonly ingestedThrough: number;
  /** Every record above max(since, ingestedThrough), in seq order. */
  readonly records: readonly WalRecord[];
};

function idbName(dbName: DbName): string {
  return `opfs-lsm-wal/${dbName}`;
}

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer as ArrayBuffer;
}

function num(raw: unknown): number {
  return typeof raw === "number" ? raw : 0;
}

function encodeOps(ops: readonly CheckedOp[]): unknown {
  return ops.map((op) =>
    op.type === "put"
      ? { type: "put", key: bufferOf(op.key), value: bufferOf(op.value) }
      : { type: "del", key: bufferOf(op.key) },
  );
}

/** A record is its encoded ops. Records written before that wrap them as `{ ops }`. */
function recordOps(value: unknown): unknown {
  return Array.isArray(value) ? value : (value as { ops?: unknown } | null)?.ops;
}

function decodeOps(raw: unknown): CheckedOp[] {
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

/**
 * Bring an older schema to v6. v2 to v4 already have a seq-keyed WAL. v5
 * kept one row per key, so seqs whose rows were all overwritten are gone.
 * Its uningested rows become one record right after ingestedThrough, which
 * keeps the WAL gap-free. No tab holds a seq across an upgrade.
 */
function migrate(tx: IDBTransaction, oldVersion: number): void {
  const db = tx.db;
  const meta = tx.objectStore(META_STORE);
  const wal = tx.objectStore(WAL_STORE);
  const ingestedReq = meta.get(META_INGESTED);
  ingestedReq.onsuccess = () => {
    const through = num(ingestedReq.result);
    if (oldVersion === 5 && db.objectStoreNames.contains(LEGACY_MEM_STORE)) {
      const ops: unknown[] = [];
      const cur = tx.objectStore(LEGACY_MEM_STORE).openCursor();
      cur.onsuccess = () => {
        const cursor = cur.result;
        if (cursor) {
          const row = cursor.value as {
            seq: number;
            kind: "put" | "del";
            value?: ArrayBuffer;
          };
          if (row.seq > through) {
            const op =
              row.kind === "put"
                ? { type: "put", key: cursor.key, value: row.value }
                : { type: "del", key: cursor.key };
            ops.push(op);
          }
          cursor.continue();
          return;
        }
        if (ops.length > 0) wal.put(ops, through + 1);
        meta.put(ops.length > 0 ? through + 1 : through, META_HEAD);
        db.deleteObjectStore(LEGACY_MEM_STORE);
      };
      return;
    }
    if (db.objectStoreNames.contains(LEGACY_MEM_STORE)) {
      db.deleteObjectStore(LEGACY_MEM_STORE);
    }
    const last = wal.openCursor(null, "prev");
    last.onsuccess = () => {
      const top = last.result ? (last.result.key as number) : 0;
      meta.put(Math.max(top, through), META_HEAD);
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
      if (ev.oldVersion > 0 && ev.oldVersion < 2) {
        for (const name of [...db.objectStoreNames]) db.deleteObjectStore(name);
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE);
      }
      if (!db.objectStoreNames.contains(WAL_STORE)) {
        db.createObjectStore(WAL_STORE, { autoIncrement: true });
      }
      if (ev.oldVersion >= 2) migrate(tx, ev.oldVersion);
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

function readRecords(
  wal: IDBObjectStore,
  range: IDBKeyRange | null,
): Promise<WalRecord[]> {
  const out: WalRecord[] = [];
  return new Promise((resolve, reject) => {
    const req = wal.openCursor(range);
    req.onerror = () => reject(req.error ?? new CommitError("cursor failed"));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve(out);
        return;
      }
      out.push({
        seq: cursor.key as number,
        ops: decodeOps(recordOps(cursor.value)),
      });
      cursor.continue();
    };
  });
}

async function readTail(tx: IDBTransaction, since: number): Promise<WalTail> {
  const meta = tx.objectStore(META_STORE);
  const [head, generation, ingestedThrough, records] = await Promise.all([
    reqToPromise(meta.get(META_HEAD)).then(num),
    reqToPromise(meta.get(META_GENERATION)).then(num),
    reqToPromise(meta.get(META_INGESTED)).then(num),
    readRecords(tx.objectStore(WAL_STORE), IDBKeyRange.lowerBound(since, true)),
  ]);
  return {
    head,
    generation,
    ingestedThrough,
    records: records.filter((r) => r.seq > ingestedThrough),
  };
}

/**
 * One shared IDB database for every tab of a database name. The WAL is the
 * only durable copy of a write until ingest folds it into an SST. Each tab
 * keeps its own memtable in memory. Ack = transaction complete.
 */
export class IdBWal {
  private constructor(
    readonly dbName: DbName,
    private readonly db: IDBDatabase,
  ) {}

  static async open(dbName: DbName): Promise<IdBWal> {
    return new IdBWal(dbName, await openIdb(dbName));
  }

  close(): void {
    this.db.close();
  }

  /** The tail after `since`, from one readonly transaction. */
  async tail(since: number): Promise<WalTail> {
    const tx = this.db.transaction([WAL_STORE, META_STORE], "readonly");
    const done = txDone(tx);
    const tail = await readTail(tx, since);
    await done;
    return tail;
  }

  /**
   * In one readwrite transaction, read the tail after `since`, let `decide`
   * choose a batch, and append it under the next seq. `decide` runs
   * synchronously inside the transaction. Returning undefined writes nothing,
   * and a throw aborts the transaction and rethrows.
   */
  async appendAfter<R>(
    since: number,
    decide: (
      tail: WalTail,
    ) => { readonly ops: readonly CheckedOp[]; readonly result: R } | undefined,
  ): Promise<
    | {
        readonly seq: number | undefined;
        readonly ops: readonly CheckedOp[];
        readonly result: R;
      }
    | undefined
  > {
    const tx = this.db.transaction([WAL_STORE, META_STORE], "readwrite");
    const done = txDone(tx);
    const tail = await readTail(tx, since);
    let decision: ReturnType<typeof decide>;
    try {
      decision = decide(tail);
    } catch (err) {
      tx.abort();
      await done.catch(() => undefined);
      throw err;
    }
    if (!decision || decision.ops.length === 0) {
      await done;
      return decision && { seq: undefined, ops: [], result: decision.result };
    }
    const seq = tail.head + 1;
    tx.objectStore(WAL_STORE).add(
      encodeOps(decision.ops),
      seq,
    );
    tx.objectStore(META_STORE).put(seq, META_HEAD);
    await done;
    return { seq, ops: decision.ops, result: decision.result };
  }

  /**
   * Append `ops` under the key IndexedDB assigns, with no read before the
   * add. An aborted transaction gives its key back, so committed seqs stay
   * gapless. Undefined when the assigned key is not past the head, which a
   * migrated database can hold until one explicit-key append raises its
   * key generator; the caller then appends with `appendAfter`.
   */
  async append(ops: readonly CheckedOp[]): Promise<number | undefined> {
    const tx = this.db.transaction([WAL_STORE, META_STORE], "readwrite");
    const done = txDone(tx);
    const meta = tx.objectStore(META_STORE);
    const head = meta.get(META_HEAD);
    const add = tx.objectStore(WAL_STORE).add(encodeOps(ops));
    let seq: number | undefined;
    let stale = false;
    add.onsuccess = () => {
      const key = add.result as number;
      if (key <= num(head.result)) {
        stale = true;
        tx.abort();
        return;
      }
      seq = key;
      meta.put(key, META_HEAD);
    };
    try {
      await done;
    } catch (err) {
      if (stale) return undefined;
      throw err;
    }
    return seq;
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

  async getIngestedThrough(): Promise<number> {
    const tx = this.db.transaction(META_STORE, "readonly");
    const raw = await reqToPromise(tx.objectStore(META_STORE).get(META_INGESTED));
    await txDone(tx);
    return num(raw);
  }

  /** All records with seq > ingestedThrough, ascending. */
  async listUningested(): Promise<WalRecord[]> {
    const tx = this.db.transaction([WAL_STORE, META_STORE], "readonly");
    const done = txDone(tx);
    const through = num(
      await reqToPromise(tx.objectStore(META_STORE).get(META_INGESTED)),
    );
    const records = await readRecords(
      tx.objectStore(WAL_STORE),
      IDBKeyRange.lowerBound(through, true),
    );
    await done;
    return records;
  }

  /**
   * Mark seqs <= through as ingested, record `generation` in the same
   * transaction, and delete those records. A tab that has not read them
   * jumps to the SST for that generation.
   */
  async advanceIngested(through: number, generation: number): Promise<void> {
    const tx = this.db.transaction([WAL_STORE, META_STORE], "readwrite");
    const done = txDone(tx);
    const meta = tx.objectStore(META_STORE);
    const [existing, prevGen] = await Promise.all([
      reqToPromise(meta.get(META_INGESTED)).then(num),
      reqToPromise(meta.get(META_GENERATION)).then(num),
    ]);
    if (through > existing) {
      tx.objectStore(WAL_STORE).delete(IDBKeyRange.upperBound(through));
      meta.put(through, META_INGESTED);
      meta.put(Math.max(prevGen, generation), META_GENERATION);
    }
    await done;
  }
}

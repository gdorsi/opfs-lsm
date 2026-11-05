import { opsBytes, type CheckedOp, type DbName } from "../check.js";
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
const META_PENDING = "pendingBytes";
const IDB_VERSION = 1;

export type WalReadProfile = {
  ms: number;
  rows: number;
};

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

function openIdb(dbName: DbName): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(idbName(dbName), IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE);
      }
      if (!db.objectStoreNames.contains(WAL_STORE)) {
        db.createObjectStore(WAL_STORE, { autoIncrement: true });
      }
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

/** Keys and values in one shot. A per-row cursor clones each value on its own turn. */
async function readRecords(
  wal: IDBObjectStore,
  range: IDBKeyRange | null,
): Promise<WalRecord[]> {
  const [keys, values] = await Promise.all([
    reqToPromise(wal.getAllKeys(range)),
    reqToPromise(wal.getAll(range)),
  ]);
  if (keys.length !== values.length) {
    throw new CommitError("wal keys and values differ");
  }
  const out: WalRecord[] = [];
  for (let i = 0; i < keys.length; i++) {
    const seq = keys[i];
    if (typeof seq !== "number") throw new CommitError("wal key is not a seq");
    out.push({ seq, ops: decodeOps(values[i]) });
  }
  return out;
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
  async tail(since: number, profile?: WalReadProfile): Promise<WalTail> {
    const started = profile ? performance.now() : 0;
    const tx = this.db.transaction([WAL_STORE, META_STORE], "readonly");
    const done = txDone(tx);
    const tail = await readTail(tx, since);
    await done;
    if (profile) {
      profile.ms = performance.now() - started;
      profile.rows = tail.records.length;
    }
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
    const meta = tx.objectStore(META_STORE);
    const pendingReq = reqToPromise(meta.get(META_PENDING));
    const [tail, pendingRaw] = await Promise.all([readTail(tx, since), pendingReq]);
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
    tx.objectStore(WAL_STORE).add(encodeOps(decision.ops), seq);
    meta.put(seq, META_HEAD);
    meta.put(num(pendingRaw) + opsBytes(decision.ops), META_PENDING);
    await done;
    return { seq, ops: decision.ops, result: decision.result };
  }

  /**
   * Append `ops` under the key IndexedDB assigns, with no read before the
   * add. An aborted transaction gives its key back, so committed seqs stay
   * gapless. Undefined when the assigned key is not past the head. The
   * caller then appends with `appendAfter`, which writes an explicit key
   * and moves the generator forward.
   */
  async append(ops: readonly CheckedOp[]): Promise<number | undefined> {
    const tx = this.db.transaction([WAL_STORE, META_STORE], "readwrite");
    const done = txDone(tx);
    const meta = tx.objectStore(META_STORE);
    const head = meta.get(META_HEAD);
    const pending = meta.get(META_PENDING);
    const bytes = opsBytes(ops);
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
      meta.put(num(pending.result) + bytes, META_PENDING);
    };
    try {
      await done;
    } catch (err) {
      if (stale) return undefined;
      throw err;
    }
    return seq;
  }

  /** The recorded generation. Undefined until an ingest records one. */
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

  /** Bytes still in the WAL. A database with no counter is scanned once and stored. */
  async uningestedBytes(): Promise<number> {
    const known = await this.pendingBytes();
    if (known !== undefined) return known;
    const tx = this.db.transaction([WAL_STORE, META_STORE], "readwrite");
    const done = txDone(tx);
    const meta = tx.objectStore(META_STORE);
    const [raw, through, records] = await Promise.all([
      reqToPromise(meta.get(META_PENDING)),
      reqToPromise(meta.get(META_INGESTED)).then(num),
      readRecords(tx.objectStore(WAL_STORE), null),
    ]);
    if (typeof raw === "number") {
      await done;
      return raw;
    }
    let bytes = 0;
    for (const record of records) {
      if (record.seq > through) bytes += opsBytes(record.ops);
    }
    meta.put(bytes, META_PENDING);
    await done;
    return bytes;
  }

  private async pendingBytes(): Promise<number | undefined> {
    const tx = this.db.transaction(META_STORE, "readonly");
    const raw = await reqToPromise(tx.objectStore(META_STORE).get(META_PENDING));
    await txDone(tx);
    return typeof raw === "number" ? raw : undefined;
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
  async advanceIngested(
    through: number,
    generation: number,
    foldedBytes: number,
  ): Promise<void> {
    const tx = this.db.transaction([WAL_STORE, META_STORE], "readwrite");
    const done = txDone(tx);
    const meta = tx.objectStore(META_STORE);
    const [existing, prevGen, pending] = await Promise.all([
      reqToPromise(meta.get(META_INGESTED)).then(num),
      reqToPromise(meta.get(META_GENERATION)).then(num),
      reqToPromise(meta.get(META_PENDING)).then(num),
    ]);
    if (through > existing) {
      tx.objectStore(WAL_STORE).delete(IDBKeyRange.upperBound(through));
      meta.put(through, META_INGESTED);
      meta.put(Math.max(prevGen, generation), META_GENERATION);
      meta.put(Math.max(0, pending - foldedBytes), META_PENDING);
    }
    await done;
  }
}

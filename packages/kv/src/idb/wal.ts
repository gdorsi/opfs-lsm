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

function num(raw: unknown): number {
  return typeof raw === "number" ? raw : 0;
}

const OP_PUT = 0;
const OP_DEL = 1;

/**
 * A WAL row is one ArrayBuffer: per op, a type byte, a u32 key length, the
 * key, and for a put a u32 value length and the value (little-endian).
 * IndexedDB clones one buffer per row instead of an array of op objects with
 * a buffer per key and value.
 */
function encodeOps(ops: readonly CheckedOp[]): ArrayBuffer {
  let size = 0;
  for (const op of ops) {
    size += 5 + op.key.byteLength + (op.type === "put" ? 4 + op.value.byteLength : 0);
  }
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  for (const op of ops) {
    view.setUint8(at, op.type === "put" ? OP_PUT : OP_DEL);
    view.setUint32(at + 1, op.key.byteLength, true);
    out.set(op.key, at + 5);
    at += 5 + op.key.byteLength;
    if (op.type === "put") {
      view.setUint32(at, op.value.byteLength, true);
      out.set(op.value, at + 4);
      at += 4 + op.value.byteLength;
    }
  }
  return out.buffer;
}

/** Keys and values are views into the row's buffer, which nothing else holds. */
function decodeOps(raw: unknown): CheckedOp[] {
  if (!(raw instanceof ArrayBuffer)) throw new CommitError("corrupt wal row: not bytes");
  const bytes = new Uint8Array(raw);
  const view = new DataView(raw);
  const ops: CheckedOp[] = [];
  let at = 0;
  const take = (length: number): Uint8Array => {
    if (at + length > bytes.byteLength) throw new CommitError("corrupt wal row: truncated");
    const out = bytes.subarray(at, at + length);
    at += length;
    return out;
  };
  const u32 = (): number => {
    if (at + 4 > bytes.byteLength) throw new CommitError("corrupt wal row: truncated");
    const n = view.getUint32(at, true);
    at += 4;
    return n;
  };
  while (at < bytes.byteLength) {
    const type = view.getUint8(at);
    at += 1;
    const key = take(u32()) as CheckedOp["key"];
    if (type === OP_PUT) {
      const value = take(u32()) as Extract<CheckedOp, { type: "put" }>["value"];
      ops.push({ type: "put", key, value });
    } else if (type === OP_DEL) {
      ops.push({ type: "del", key });
    } else {
      throw new CommitError(`corrupt wal op ${type}`);
    }
  }
  return ops;
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

/** Seqs per `getAll`. Every chunk of a read is in flight at once. */
const READ_CHUNK = 25_000;

/**
 * Records with `after < seq <= head`, ascending. Committed seqs are gapless
 * above ingestedThrough, so a value's position in its range gives its seq,
 * and no `getAllKeys` pass is needed. A short range is a gap and throws, the
 * way `catchUp` throws on one. IDB read cost is per row, and ranges in flight
 * together read faster than one `getAll` over the whole tail.
 * `getAllRecords` is not used: Chrome defers deserializing its values to the
 * first `.value` read, so the time it saves comes back in decode.
 */
async function readRecords(
  wal: IDBObjectStore,
  after: number,
  head: number,
): Promise<WalRecord[]> {
  const chunks: Promise<WalRecord[]>[] = [];
  for (let lo = after + 1; lo <= head; lo += READ_CHUNK) {
    const hi = Math.min(head, lo + READ_CHUNK - 1);
    chunks.push(
      reqToPromise(wal.getAll(IDBKeyRange.bound(lo, hi))).then((values) => {
        if (values.length !== hi - lo + 1) {
          throw new CommitError(`wal gap in seqs ${lo}..${hi}`);
        }
        return values.map((value, i) => ({ seq: lo + i, ops: decodeOps(value) }));
      }),
    );
  }
  return (await Promise.all(chunks)).flat();
}

async function readTail(tx: IDBTransaction, since: number): Promise<WalTail> {
  const meta = tx.objectStore(META_STORE);
  const [head, generation, ingestedThrough] = await Promise.all([
    reqToPromise(meta.get(META_HEAD)).then(num),
    reqToPromise(meta.get(META_GENERATION)).then(num),
    reqToPromise(meta.get(META_INGESTED)).then(num),
  ]);
  const records = await readRecords(
    tx.objectStore(WAL_STORE),
    Math.max(since, ingestedThrough),
    head,
  );
  return { head, generation, ingestedThrough, records };
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
    const [raw, through, head] = await Promise.all([
      reqToPromise(meta.get(META_PENDING)),
      reqToPromise(meta.get(META_INGESTED)).then(num),
      reqToPromise(meta.get(META_HEAD)).then(num),
    ]);
    if (typeof raw === "number") {
      await done;
      return raw;
    }
    let bytes = 0;
    for (const record of await readRecords(tx.objectStore(WAL_STORE), through, head)) {
      bytes += opsBytes(record.ops);
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
    const meta = tx.objectStore(META_STORE);
    const [through, head] = await Promise.all([
      reqToPromise(meta.get(META_INGESTED)).then(num),
      reqToPromise(meta.get(META_HEAD)).then(num),
    ]);
    const records = await readRecords(tx.objectStore(WAL_STORE), through, head);
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

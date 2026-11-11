import { opsBytes, type CheckedOp, type DbName } from "../check.js";
import { CommitError, StorageUnavailableError } from "../errors.js";
import type { WalRecord } from "../store/memtable.js";

/**
 * One record per batch, keyed by seq. Holds the seqs above ingestedThrough,
 * and the seqs the last ingest folded, kept until the next one (design.md,
 * "Truncation").
 */
const WAL_STORE = "wal";
const META_STORE = "meta";
/**
 * A floor for the head. The head, the seq of the last committed batch, is
 * the larger of this and the last key in `wal`. An append writes only its
 * record: a write to `meta` in the same transaction costs about as much
 * again as the record. Recovery raises the floor when it moves the head
 * past the records.
 */
const META_HEAD = "head";
const META_INGESTED = "ingestedThrough";
/** The OPFS generation whose runs hold every seq <= ingestedThrough. */
const META_GENERATION = "generation";
/**
 * The highest manifest number recovery has seen. Recovery can record an
 * older manifest than the one IndexedDB named; new manifests number past
 * this, so a number is never reused for other runs.
 */
const META_TOP = "topGeneration";
const IDB_VERSION = 1;

/** The `meta` keys that say which log prefix the WAL and the manifest hold. */
export type WalMeta = {
  readonly head: number;
  readonly ingestedThrough: number;
  /** Undefined until an open or an ingest records one. */
  readonly generation: number | undefined;
  /** The highest manifest number recovery has seen, 0 for none. */
  readonly top: number;
};

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

/**
 * Keys and values are views into the row's buffer, which nothing else holds.
 * Exported for the decoder fuzz tests (`packages/kv/fuzz/`).
 */
export function decodeOps(raw: unknown): CheckedOp[] {
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
    req.onerror = () => {
      const cause = req.error;
      const detail = cause ? ` (${cause.name}: ${cause.message})` : "";
      reject(new StorageUnavailableError(`the browser's IndexedDB store failed to open${detail}`, { cause }));
    };
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

/** The seq of the last committed batch: the last key in `wal`, or the floor in `meta` when that is higher. */
async function readHead(tx: IDBTransaction): Promise<number> {
  const [floor, last] = await Promise.all([
    reqToPromise(tx.objectStore(META_STORE).get(META_HEAD)).then(num),
    reqToPromise(tx.objectStore(WAL_STORE).openKeyCursor(null, "prev")).then((cursor) =>
      num(cursor?.key),
    ),
  ]);
  return Math.max(floor, last);
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

/**
 * The oldest records with `after < seq <= head` whose op bytes fit in
 * `maxBytes`, and at least one. It reads one record first, then sizes each
 * read from the bytes per record so far, so a WAL of large records is never
 * read far past the cap. A record that would not fit is read and left for the
 * next call.
 */
async function readRecordsUpTo(
  wal: IDBObjectStore,
  after: number,
  head: number,
  maxBytes: number,
): Promise<WalRecord[]> {
  const records: WalRecord[] = [];
  let bytes = 0;
  let span = 1;
  for (let lo = after + 1; lo <= head; ) {
    const hi = Math.min(head, lo + span - 1);
    const values = await reqToPromise(wal.getAll(IDBKeyRange.bound(lo, hi)));
    if (values.length !== hi - lo + 1) {
      throw new CommitError(`wal gap in seqs ${lo}..${hi}`);
    }
    for (const [i, value] of values.entries()) {
      const ops = decodeOps(value);
      const size = opsBytes(ops);
      if (records.length > 0 && bytes + size > maxBytes) return records;
      records.push({ seq: lo + i, ops });
      bytes += size;
    }
    lo = hi + 1;
    const fits = ((maxBytes - bytes) * records.length) / Math.max(bytes, 1);
    span = Math.max(1, Math.min(READ_CHUNK, Math.floor(fits)));
  }
  return records;
}

async function readTail(tx: IDBTransaction, since: number): Promise<WalTail> {
  const meta = tx.objectStore(META_STORE);
  const [head, generation, ingestedThrough] = await Promise.all([
    readHead(tx),
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
  /** WAL records this handle committed. Test and bench only. */
  appendedRecords = 0;
  /** Encoded bytes of those records. */
  appendedBytes = 0;
  /** `append` transactions that committed. `appendedRecords / appendedCommits` is the mean group size. */
  appendedCommits = 0;
  private queued: {
    readonly record: ArrayBuffer;
    readonly resolve: (seq: number | undefined) => void;
    readonly reject: (err: unknown) => void;
  }[] = [];
  private writing = false;

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
    const record = encodeOps(decision.ops);
    tx.objectStore(WAL_STORE).add(record, seq);
    await done;
    this.appendedRecords += 1;
    this.appendedBytes += record.byteLength;
    return { seq, ops: decision.ops, result: decision.result };
  }

  /**
   * Append `ops` under the key IndexedDB assigns. Appends that arrive while
   * a transaction is open wait, and the next transaction writes all of them,
   * one `add` each, so every record keeps its own seq. A group commits or
   * aborts as a whole. Resolves with the seq once the transaction completes,
   * in seq order within a group.
   *
   * The record is the only write. The key generator is past every key in
   * `wal`, so the key can only fail to pass the head when recovery raised
   * the floor: undefined then, for every append of the group, and the caller
   * appends with `appendAfter`, which writes an explicit key and moves the
   * generator forward. An aborted transaction gives its keys back, so
   * committed seqs stay gapless.
   */
  append(ops: readonly CheckedOp[]): Promise<number | undefined> {
    return new Promise((resolve, reject) => {
      this.queued.push({ record: encodeOps(ops), resolve, reject });
      if (!this.writing) this.commit();
    });
  }

  /** Writes everything queued in one transaction. At most one runs at a time. */
  private commit(): void {
    const group = this.queued;
    this.queued = [];
    this.writing = true;
    const fail = (err: unknown) => {
      this.next();
      for (const q of group) q.reject(err);
    };
    let tx: IDBTransaction;
    try {
      tx = this.db.transaction([WAL_STORE, META_STORE], "readwrite");
    } catch (err) {
      fail(err);
      return;
    }
    const floor = tx.objectStore(META_STORE).get(META_HEAD);
    const wal = tx.objectStore(WAL_STORE);
    const seqs: number[] = [];
    let stale = false;
    let thrown: unknown;
    try {
      for (const [i, q] of group.entries()) {
        const add = wal.add(q.record);
        add.onsuccess = () => {
          seqs[i] = add.result as number;
          if (i === 0 && seqs[0]! <= num(floor.result)) {
            stale = true;
            tx.abort();
          }
        };
      }
    } catch (err) {
      thrown = err;
      tx.abort();
    }
    tx.oncomplete = () => {
      this.appendedCommits += 1;
      this.appendedRecords += group.length;
      for (const q of group) this.appendedBytes += q.record.byteLength;
      this.next();
      for (const [i, q] of group.entries()) q.resolve(seqs[i]);
    };
    tx.onabort = () => {
      if (stale) {
        this.next();
        for (const q of group) q.resolve(undefined);
      } else {
        fail(thrown ?? tx.error ?? new CommitError("idb tx aborted"));
      }
    };
  }

  /** The open transaction ended: start the group that queued behind it. */
  private next(): void {
    this.writing = false;
    if (this.queued.length > 0) this.commit();
  }

  async meta(): Promise<WalMeta> {
    const tx = this.db.transaction([WAL_STORE, META_STORE], "readonly");
    const meta = tx.objectStore(META_STORE);
    const [head, ingestedThrough, generation, top] = await Promise.all([
      readHead(tx),
      reqToPromise(meta.get(META_INGESTED)).then(num),
      reqToPromise(meta.get(META_GENERATION)),
      reqToPromise(meta.get(META_TOP)).then(num),
    ]);
    await txDone(tx);
    return {
      head,
      ingestedThrough,
      generation: typeof generation === "number" ? generation : undefined,
      top,
    };
  }

  /**
   * Pair the WAL with manifest `generation`, whose runs hold the log
   * through seq `through` (design.md, "Recovery"). `head` moves up to at
   * least `floor`, and `topGeneration` to at least `top`. Writes nothing and
   * returns false unless `meta` still reads `expect`. Then, in one
   * transaction:
   * - `through` at or past `ingestedThrough`: the manifest holds every
   *   folded seq, and the WAL records above it follow it.
   *   `ingestedThrough` moves to `through`.
   * - `through` below it, and the WAL still holds every seq above
   *   `through`: those seqs are uningested again.
   * - Otherwise no record can follow the manifest: the seqs between it and
   *   the WAL are gone from both stores, or `head` had to move past seqs
   *   the WAL never held. Every record is dropped and `ingestedThrough`
   *   moves to the new `head`: the database is the manifest alone.
   * `head` never moves down, so a seq is never reused.
   */
  async adopt(
    expect: WalMeta,
    generation: number,
    through: number,
    floor = through,
    top = generation,
  ): Promise<boolean> {
    const tx = this.db.transaction([WAL_STORE, META_STORE], "readwrite");
    const done = txDone(tx);
    const meta = tx.objectStore(META_STORE);
    const wal = tx.objectStore(WAL_STORE);
    const [head, ingested, recorded, knownTop] = await Promise.all([
      readHead(tx),
      reqToPromise(meta.get(META_INGESTED)).then(num),
      reqToPromise(meta.get(META_GENERATION)),
      reqToPromise(meta.get(META_TOP)).then(num),
    ]);
    if (
      head !== expect.head ||
      knownTop !== expect.top ||
      ingested !== expect.ingestedThrough ||
      (typeof recorded === "number" ? recorded : undefined) !== expect.generation
    ) {
      await done;
      return false;
    }
    const above =
      head > through
        ? await reqToPromise(wal.getAll(IDBKeyRange.bound(through + 1, head)))
        : [];
    const nextHead = Math.max(head, through, floor);
    let nextIngested = through;
    if (nextHead === head && (through >= ingested || above.length === head - through)) {
      wal.delete(IDBKeyRange.upperBound(Math.min(ingested, through)));
    } else {
      // No record can follow the manifest: drop them all, and start the
      // WAL past every seq handed out.
      nextIngested = nextHead;
      wal.delete(IDBKeyRange.upperBound(head));
    }
    meta.put(nextHead, META_HEAD);
    meta.put(nextIngested, META_INGESTED);
    meta.put(generation, META_GENERATION);
    meta.put(Math.max(knownTop, top, generation), META_TOP);
    await done;
    return true;
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

  /**
   * Op bytes of the records above ingestedThrough, read from the records.
   * With `cap`, the read stops once the next record would pass it. The
   * answer is then at least `cap`: the bytes already read, when those
   * already pass `cap`, otherwise `cap`. The ingest watch compares that
   * with `maxWalBytes`, so a long WAL still trips the limit.
   */
  async uningestedBytes(cap = Number.POSITIVE_INFINITY): Promise<number> {
    const tx = this.db.transaction([WAL_STORE, META_STORE], "readonly");
    const done = txDone(tx);
    const [through, head] = await Promise.all([
      reqToPromise(tx.objectStore(META_STORE).get(META_INGESTED)).then(num),
      readHead(tx),
    ]);
    const store = tx.objectStore(WAL_STORE);
    const records = Number.isFinite(cap)
      ? await readRecordsUpTo(store, through, head, cap)
      : await readRecords(store, through, head);
    await done;
    let bytes = 0;
    for (const record of records) bytes += opsBytes(record.ops);
    const last = records[records.length - 1]?.seq ?? head;
    return last < head ? Math.max(bytes, cap) : bytes;
  }

  /**
   * The records with seq > ingestedThrough, ascending. With `maxBytes`, only
   * the oldest ones whose op bytes fit in it, and at least one: a record
   * larger than the cap comes alone.
   */
  async listUningested(limit?: { readonly maxBytes: number }): Promise<WalRecord[]> {
    const tx = this.db.transaction([WAL_STORE, META_STORE], "readonly");
    const done = txDone(tx);
    const meta = tx.objectStore(META_STORE);
    const [through, head] = await Promise.all([
      reqToPromise(meta.get(META_INGESTED)).then(num),
      readHead(tx),
    ]);
    const store = tx.objectStore(WAL_STORE);
    const records = limit
      ? await readRecordsUpTo(store, through, head, limit.maxBytes)
      : await readRecords(store, through, head);
    await done;
    return records;
  }

  /**
   * Mark seqs <= through as ingested and record `generation` in the same
   * transaction. A tab that has not read them jumps to the SST for that
   * generation. Deletes the records the previous ingest folded: the ones
   * this ingest folded stay until the next, so a power loss that keeps this
   * commit and loses the new manifest can still recover them (design.md,
   * "Recovery").
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
      tx.objectStore(WAL_STORE).delete(IDBKeyRange.upperBound(existing));
      meta.put(through, META_INGESTED);
      meta.put(Math.max(prevGen, generation), META_GENERATION);
    }
    await done;
  }
}

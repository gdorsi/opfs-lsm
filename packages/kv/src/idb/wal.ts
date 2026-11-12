import { compareBytes } from "../bytes.js";
import { opsBytes, type CheckedKey, type CheckedOp, type CheckedValue, type DbName, type RecordOp } from "../check.js";
import { CommitError, StorageUnavailableError } from "../errors.js";
import { resolveThrough } from "../store/marks.js";
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
/**
 * The `topGeneration` the last destroy recorded. Manifests numbered at or
 * below it hold writes from before that destroy, so recovery adopts none.
 */
const META_DESTROYED_TOP = "destroyedTop";
const IDB_VERSION = 1;

/** The `meta` keys that say which log prefix the WAL and the manifest hold. */
export type WalMeta = {
  readonly head: number;
  readonly ingestedThrough: number;
  /** Undefined until an open or an ingest records one. */
  readonly generation: number | undefined;
  /** The highest manifest number recovery has seen, 0 for none. */
  readonly top: number;
  /** The `topGeneration` the last destroy recorded, 0 for none. */
  readonly destroyedTop: number;
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

/** A `meta` number, 0 when unset. */
function metaNum(meta: IDBObjectStore, key: string): Promise<number> {
  return reqToPromise(meta.get(key)).then(num);
}

/** A `meta` number, undefined when unset. */
function metaOpt(meta: IDBObjectStore, key: string): Promise<number | undefined> {
  return reqToPromise(meta.get(key)).then((raw) => (typeof raw === "number" ? raw : undefined));
}

const EMPTY_RECORD = new ArrayBuffer(0);

const OP_PUT = 0;
const OP_DEL = 1;
const OP_DELETE_RANGE = 3;
/** The `through` stored for a range delete that asked for none: every row before its batch. */
const BEFORE_THIS_BATCH = Number.MAX_SAFE_INTEGER;

/**
 * A WAL row is one ArrayBuffer of ops back to back (design.md, "WAL
 * records"). IndexedDB clones one buffer per row instead of an array of op
 * objects with a buffer per key and value. A range delete stores the
 * `through` its caller asked for; readers resolve it against the row's seq.
 */
export function encodeOps(ops: readonly CheckedOp[]): ArrayBuffer {
  let size = 0;
  for (const op of ops) {
    size +=
      op.type === "deleteRange"
        ? 1 + 4 + op.start.byteLength + 1 + (op.endExclusive ? 4 + op.endExclusive.byteLength : 0) + 8
        : 5 + op.key.byteLength + (op.type === "put" ? 4 + op.value.byteLength : 0);
  }
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  const bytes = (b: Uint8Array) => {
    view.setUint32(at, b.byteLength, true);
    out.set(b, at + 4);
    at += 4 + b.byteLength;
  };
  for (const op of ops) {
    if (op.type === "deleteRange") {
      view.setUint8(at++, OP_DELETE_RANGE);
      bytes(op.start);
      view.setUint8(at++, op.endExclusive ? 1 : 0);
      if (op.endExclusive) bytes(op.endExclusive);
      view.setBigUint64(at, BigInt(op.through ?? BEFORE_THIS_BATCH), true);
      at += 8;
      continue;
    }
    view.setUint8(at++, op.type === "put" ? OP_PUT : OP_DEL);
    bytes(op.key);
    if (op.type === "put") bytes(op.value);
  }
  return out.buffer;
}

/** The ops of `record` with each range delete's `through` resolved against `seq`. */
export function resolveOps(ops: readonly CheckedOp[], seq: number): readonly RecordOp[] {
  if (!ops.some((op) => op.type === "deleteRange")) return ops as readonly RecordOp[];
  return ops.map((op) =>
    op.type === "deleteRange" ? { ...op, through: resolveThrough(op.through ?? BEFORE_THIS_BATCH, seq) } : op,
  );
}

/**
 * The ops of the row at `seq`. Keys and values are views into the row's
 * buffer, which nothing else holds. Exported for the decoder fuzz tests
 * (`packages/kv/fuzz/`).
 */
export function decodeOps(raw: unknown, seq: number): RecordOp[] {
  if (!(raw instanceof ArrayBuffer)) throw new CommitError("corrupt wal row: not bytes");
  const bytes = new Uint8Array(raw);
  const view = new DataView(raw);
  const ops: RecordOp[] = [];
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
    const key = take(u32()) as CheckedKey;
    if (type === OP_PUT) {
      const value = take(u32()) as CheckedValue;
      ops.push({ type: "put", key, value });
    } else if (type === OP_DEL) {
      ops.push({ type: "del", key });
    } else if (type === OP_DELETE_RANGE) {
      const hasEnd = take(1)[0]!;
      if (hasEnd > 1) throw new CommitError("corrupt wal row: end flag");
      const end = hasEnd === 1 ? (take(u32()) as CheckedKey) : undefined;
      const stored = take(8);
      const through = new DataView(stored.buffer, stored.byteOffset, 8).getBigUint64(0, true);
      if (through > BigInt(BEFORE_THIS_BATCH)) throw new CommitError("corrupt wal row: through");
      if (end && compareBytes(key, end) >= 0) throw new CommitError("corrupt wal row: empty range");
      ops.push({
        type: "deleteRange",
        start: key,
        ...(end ? { endExclusive: end } : {}),
        through: resolveThrough(Number(through), seq),
      });
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
    metaNum(tx.objectStore(META_STORE), META_HEAD),
    reqToPromise(tx.objectStore(WAL_STORE).openKeyCursor(null, "prev")).then((cursor) =>
      num(cursor?.key),
    ),
  ]);
  return Math.max(floor, last);
}

async function readMeta(tx: IDBTransaction): Promise<WalMeta> {
  const meta = tx.objectStore(META_STORE);
  const [head, ingestedThrough, generation, top, destroyedTop] = await Promise.all([
    readHead(tx),
    metaNum(meta, META_INGESTED),
    metaOpt(meta, META_GENERATION),
    metaNum(meta, META_TOP),
    metaNum(meta, META_DESTROYED_TOP),
  ]);
  return { head, ingestedThrough, generation, top, destroyedTop };
}

function sameMeta(a: WalMeta, b: WalMeta): boolean {
  return (
    a.head === b.head &&
    a.ingestedThrough === b.ingestedThrough &&
    a.generation === b.generation &&
    a.top === b.top &&
    a.destroyedTop === b.destroyedTop
  );
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
        return values.map((value, i) => ({ seq: lo + i, ops: decodeOps(value, lo + i) }));
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
      const ops = decodeOps(value, lo + i);
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
    metaNum(meta, META_GENERATION),
    metaNum(meta, META_INGESTED),
  ]);
  const records = await readRecords(
    tx.objectStore(WAL_STORE),
    Math.max(since, ingestedThrough),
    head,
  );
  return { head, generation, ingestedThrough, records };
}

type GroupEntry = {
  readonly record: ArrayBuffer;
  seq: number | undefined;
  readonly resolve: (seq: number | undefined) => void;
  readonly reject: (err: unknown) => void;
};

type Group = {
  readonly tx: IDBTransaction;
  readonly entries: GroupEntry[];
  /** False once an `add` found the transaction inactive. */
  active: boolean;
  readonly landed: (entry: GroupEntry, key: number) => void;
};

/**
 * One connection to the IDB database every tab of a database name shares.
 * The WAL is the only durable copy of a write until ingest folds it into an
 * SST. This is what a tab and the host both need: the meta record and the
 * recovery write. `TabWal` adds the tab's reads and appends. The host's
 * transactions are the functions below it.
 */
export class IdBWal {
  protected constructor(
    readonly dbName: DbName,
    readonly db: IDBDatabase,
  ) {}

  static async open(dbName: DbName): Promise<IdBWal> {
    return new IdBWal(dbName, await openIdb(dbName));
  }

  close(): void {
    this.db.close();
  }

  async meta(): Promise<WalMeta> {
    return readMeta(this.db.transaction([WAL_STORE, META_STORE], "readonly"));
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
    floor: number,
    top: number,
  ): Promise<boolean> {
    const tx = this.db.transaction([WAL_STORE, META_STORE], "readwrite");
    const done = txDone(tx);
    const meta = tx.objectStore(META_STORE);
    const wal = tx.objectStore(WAL_STORE);
    const now = await readMeta(tx);
    if (!sameMeta(now, expect)) {
      await done;
      return false;
    }
    const { head, ingestedThrough: ingested, top: knownTop } = now;
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
}

/**
 * A tab's connection: it reads the tail and appends. Each tab keeps its own
 * memtable in memory. Ack = transaction complete.
 */
export class TabWal extends IdBWal {
  /** WAL records this handle committed. Test and bench only. */
  appendedRecords = 0;
  /** Encoded bytes of those records. */
  appendedBytes = 0;
  /**
   * Committed groups by size: entry i counts groups of 2^i to 2^(i+1) - 1
   * records. Test and bench only.
   */
  groupSizes: number[] = [];
  /** The group whose transaction is open, from its creation to its end. */
  private open: Group | undefined;
  /** Appends that arrived after `open` went inactive: the next group. */
  private queued: GroupEntry[] = [];
  private closing = false;

  static override async open(dbName: DbName): Promise<TabWal> {
    return new TabWal(dbName, await openIdb(dbName));
  }

  /** Closes the connection once the groups already started or queued commit. */
  override close(): void {
    this.closing = true;
    if (!this.open) this.db.close();
  }

  /** The tail after `since`, from one readonly transaction. */
  async tail(since: number): Promise<WalTail> {
    // The reads are the result. Waiting for `complete` as well is one more trip.
    const tx = this.db.transaction([WAL_STORE, META_STORE], "readonly");
    const tail = await readTail(tx, since);
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
        /** The row written: `encodeOps(ops)`. Empty when nothing was. */
        readonly record: ArrayBuffer;
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
      return decision && { seq: undefined, ops: [], record: EMPTY_RECORD, result: decision.result };
    }
    const seq = tail.head + 1;
    const record = encodeOps(decision.ops);
    tx.objectStore(WAL_STORE).add(record, seq);
    // Without this, Chrome waits for the add's success event to reach the
    // tab before it commits: one more round trip per write.
    tx.commit();
    await done;
    this.appendedRecords += 1;
    this.appendedBytes += record.byteLength;
    return { seq, ops: decision.ops, record, result: decision.result };
  }

  /**
   * Append `record` (`encodeOps`) under the key IndexedDB assigns, by group commit: appends
   * that arrive while a group's transaction is active join it, and appends
   * that arrive while it commits form the next group. A group is one
   * readwrite transaction with one `add` per record, so each record keeps
   * its own seq, and the records commit or abort together. Each caller
   * resolves when its group commits, in seq order; a failed group rejects
   * every caller in it. The key generator is past every key in `wal`, so a
   * key can only fail to pass the head when recovery raised the floor: the
   * group aborts and every caller gets undefined, and appends with
   * `appendAfter`, which writes an explicit key and moves the generator
   * forward. An aborted transaction gives its keys back, so committed seqs
   * stay gapless.
   */
  append(record: ArrayBuffer): Promise<number | undefined> {
    return new Promise((resolve, reject) => {
      const entry: GroupEntry = { record, seq: undefined, resolve, reject };
      if (this.open && this.join(this.open, entry)) return;
      if (this.open) this.queued.push(entry);
      else this.commitGroup([entry]);
    });
  }

  /** Add `entry` to `group` while its transaction is still active. */
  private join(group: Group, entry: GroupEntry): boolean {
    if (!group.active) return false;
    try {
      const add = group.tx.objectStore(WAL_STORE).add(entry.record);
      add.onsuccess = () => group.landed(entry, add.result as number);
    } catch (err) {
      if (err instanceof DOMException && err.name === "TransactionInactiveError") {
        group.active = false;
        return false;
      }
      throw err;
    }
    group.entries.push(entry);
    return true;
  }

  private commitGroup(entries: GroupEntry[]): void {
    let tx: IDBTransaction;
    try {
      tx = this.db.transaction([WAL_STORE, META_STORE], "readwrite");
    } catch (err) {
      for (const entry of entries) entry.reject(err);
      this.next();
      return;
    }
    const floor = tx.objectStore(META_STORE).get(META_HEAD);
    let stale = false;
    const group: Group = {
      tx,
      entries: [],
      active: true,
      landed: (entry, key) => {
        if (stale) return;
        if (key <= num(floor.result)) {
          stale = true;
          tx.abort();
          return;
        }
        entry.seq = key;
      },
    };
    this.open = group;
    for (const entry of entries) {
      if (!this.join(group, entry)) {
        // Unreachable: the transaction was created in this turn.
        throw new CommitError("wal group transaction inactive at open");
      }
    }
    txDone(tx).then(
      () => {
        const bucket = 31 - Math.clz32(group.entries.length);
        this.groupSizes[bucket] = (this.groupSizes[bucket] ?? 0) + 1;
        for (const entry of group.entries) {
          this.appendedRecords += 1;
          this.appendedBytes += entry.record.byteLength;
        }
        this.finish(group);
        for (const entry of group.entries) entry.resolve(entry.seq);
      },
      (err: unknown) => {
        this.finish(group);
        for (const entry of group.entries) {
          if (stale) entry.resolve(undefined);
          else entry.reject(err);
        }
      },
    );
  }

  private finish(group: Group): void {
    if (this.open === group) this.open = undefined;
    this.next();
  }

  /** Start the next group from the queue, or close when `close` waits on it. */
  private next(): void {
    if (this.open) return;
    const entries = this.queued;
    this.queued = [];
    if (entries.length > 0) this.commitGroup(entries);
    else if (this.closing) this.db.close();
  }
}

/**
 * Empty the database: drop every record, and record generation 0 with
 * `head` and `ingestedThrough` at `head`, and `topGeneration` and
 * `destroyedTop` at `top`. Writes nothing and returns false unless `meta`
 * still reads `expect`. Resolves once the commit is on disk (durability
 * "strict"), so no power loss keeps a file removed after it and loses it.
 */
export async function emptyWal(wal: IdBWal, expect: WalMeta, head: number, top: number): Promise<boolean> {
  const tx = wal.db.transaction([WAL_STORE, META_STORE], "readwrite", { durability: "strict" });
  const done = txDone(tx);
  const now = await readMeta(tx);
  if (!sameMeta(now, expect)) {
    await done;
    return false;
  }
  const meta = tx.objectStore(META_STORE);
  tx.objectStore(WAL_STORE).delete(IDBKeyRange.upperBound(now.head));
  meta.put(head, META_HEAD);
  meta.put(head, META_INGESTED);
  meta.put(0, META_GENERATION);
  meta.put(top, META_TOP);
  meta.put(top, META_DESTROYED_TOP);
  await done;
  return true;
}

/** Record `generation` unless a newer one is already recorded. */
export async function raiseGeneration(wal: IdBWal, generation: number): Promise<void> {
  const tx = wal.db.transaction(META_STORE, "readwrite");
  const meta = tx.objectStore(META_STORE);
  const recorded = await metaOpt(meta, META_GENERATION);
  if (recorded === undefined || generation > recorded) {
    meta.put(generation, META_GENERATION);
  }
  await txDone(tx);
}

export async function getIngestedThrough(wal: IdBWal): Promise<number> {
  const tx = wal.db.transaction(META_STORE, "readonly");
  const through = await metaNum(tx.objectStore(META_STORE), META_INGESTED);
  await txDone(tx);
  return through;
}

/**
 * Op bytes of the records above ingestedThrough, read from the records.
 * The read stops once the next record would pass `cap`. The
 * answer is then at least `cap`: the bytes already read, when those
 * already pass `cap`, otherwise `cap`. The ingest watch compares that
 * with `maxWalBytes`, so a long WAL still trips the limit.
 */
export async function uningestedBytes(wal: IdBWal, cap: number): Promise<number> {
  const tx = wal.db.transaction([WAL_STORE, META_STORE], "readonly");
  const done = txDone(tx);
  const [through, head] = await Promise.all([
    metaNum(tx.objectStore(META_STORE), META_INGESTED),
    readHead(tx),
  ]);
  const store = tx.objectStore(WAL_STORE);
  const records = await readRecordsUpTo(store, through, head, cap);
  await done;
  let bytes = 0;
  for (const record of records) bytes += opsBytes(record.ops);
  const last = records[records.length - 1]?.seq ?? head;
  return last < head ? Math.max(bytes, cap) : bytes;
}

/**
 * The records with seq > ingestedThrough, ascending: only the oldest ones
 * whose op bytes fit in `maxBytes`, and at least one: a record larger than
 * the cap comes alone.
 */
export async function listUningested(wal: IdBWal, limit: { readonly maxBytes: number }): Promise<WalRecord[]> {
  const tx = wal.db.transaction([WAL_STORE, META_STORE], "readonly");
  const done = txDone(tx);
  const meta = tx.objectStore(META_STORE);
  const [through, head] = await Promise.all([
    metaNum(meta, META_INGESTED),
    readHead(tx),
  ]);
  const store = tx.objectStore(WAL_STORE);
  const records = await readRecordsUpTo(store, through, head, limit.maxBytes);
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
export async function advanceIngested(wal: IdBWal, through: number, generation: number): Promise<void> {
  const tx = wal.db.transaction([WAL_STORE, META_STORE], "readwrite");
  const done = txDone(tx);
  const meta = tx.objectStore(META_STORE);
  const [existing, prevGen] = await Promise.all([
    metaNum(meta, META_INGESTED),
    metaNum(meta, META_GENERATION),
  ]);
  if (through > existing) {
    tx.objectStore(WAL_STORE).delete(IDBKeyRange.upperBound(existing));
    meta.put(through, META_INGESTED);
    meta.put(Math.max(prevGen, generation), META_GENERATION);
  }
  await done;
}

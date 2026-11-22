import { compareBytes } from "../bytes.js";
import { opsBytes, type CheckedKey, type CheckedOp, type CheckedValue, type DbName } from "../check.js";
import { ClosedError, codeOfError, CommitError, StorageFullError, StorageUnavailableError } from "../errors.js";
import {
  asGeneration,
  asSeq,
  GENERATION_NONE,
  nextSeq,
  prevSeq,
  type Generation,
  type Seq,
} from "../seq.js";
import type { WalRecord } from "../store/memtable.js";

/**
 * One record per batch, keyed by seq. Holds the seqs above ingestedThrough,
 * and the seqs the last ingest folded, kept until the next one (design.md,
 * "Truncation").
 */
const WAL_STORE = "wal";
const META_STORE = "meta";
/**
 * Every seq at or below it is in the runs of the recorded generation. It is
 * also the head when `wal` holds no record past it (`headOf`).
 */
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
/**
 * The bytes of a manifest, stored by the flush or compaction that recorded
 * its generation. A tab that reads them with the tail opens the runs while
 * it reads the manifest file. They are a copy: a recovery that records
 * another manifest leaves them, so a reader checks their number, and
 * recovery reads only OPFS.
 */
const META_MANIFEST = "manifest";

/** The `meta` keys that say which log prefix the WAL and the manifest hold. */
export type WalMeta = {
  readonly head: Seq;
  readonly ingestedThrough: Seq;
  /** Undefined until an open or an ingest records one. */
  readonly generation: Generation | undefined;
  /** The highest manifest number recovery has seen, 0 for none. */
  readonly top: Generation;
  /** The `topGeneration` the last destroy recorded, 0 for none. */
  readonly destroyedTop: Generation;
};

/** What a tab needs to bring its memtable up to the WAL head. */
export type WalTail = {
  readonly head: Seq;
  readonly generation: Generation;
  readonly ingestedThrough: Seq;
  /** Every record above max(since, ingestedThrough), in seq order. */
  readonly records: readonly WalRecord[];
  /** The `manifest` copy, read when the reader does not hold `generation`. */
  readonly manifest?: Uint8Array | undefined;
};

export function idbName(dbName: DbName): string {
  return `opfs-lsm-wal/${dbName}`;
}

function num(raw: unknown): number {
  return typeof raw === "number" ? raw : 0;
}

/** A `meta` seq, 0 when unset. */
function metaSeq(meta: IDBObjectStore, key: string): Promise<Seq> {
  return reqToPromise(meta.get(key)).then((raw) => asSeq(num(raw)));
}

/** A `meta` generation number, 0 when unset. */
function metaGeneration(meta: IDBObjectStore, key: string): Promise<Generation> {
  return reqToPromise(meta.get(key)).then((raw) => asGeneration(num(raw)));
}

/** A `meta` generation number, undefined when unset. */
function metaGenerationOpt(meta: IDBObjectStore, key: string): Promise<Generation | undefined> {
  return reqToPromise(meta.get(key)).then((raw) => (typeof raw === "number" ? asGeneration(raw) : undefined));
}

const EMPTY_RECORD = new ArrayBuffer(0);

const OP_PUT = 0;
const OP_DEL = 1;
const OP_DELETE_RANGE = 3;
/** A row's header, never an op: the type byte, then the `u64` seq the row is valid at. */
const ROW_VALID_AT = 4;

/**
 * The verdict on a row (design.md, "WAL records"): a row with a header has
 * its ops at the seq the header names, and none at any other. It depends on
 * the row's bytes and its key alone, so every reader reaches it alike:
 * through `decodeOps`, or here for the tab that wrote the row.
 */
export function rowValid(validAt: Seq | undefined, seq: Seq): boolean {
  return validAt === undefined || validAt === seq;
}

/** A range delete asked for `asked` in the record at `seq` never covers its own batch. */
function resolveThrough(asked: Seq, seq: Seq): Seq {
  return asSeq(Math.max(0, Math.min(asked, prevSeq(seq))));
}

/**
 * A WAL row is one ArrayBuffer of ops back to back (design.md, "WAL
 * records"). IndexedDB clones one buffer per row instead of an array of op
 * objects with a buffer per key and value. A range delete stores the
 * `through` its caller asked for; readers resolve it against the row's seq.
 * With `validAt`, the row starts with the header that makes it valid at
 * that seq only (`rowValid`).
 */
export function encodeOps(ops: readonly CheckedOp[], validAt?: Seq): ArrayBuffer {
  let size = validAt === undefined ? 0 : 9;
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
  const u64 = (n: number) => {
    view.setBigUint64(at, BigInt(n), true);
    at += 8;
  };
  if (validAt !== undefined) {
    view.setUint8(at++, ROW_VALID_AT);
    u64(validAt);
  }
  for (const op of ops) {
    if (op.type === "deleteRange") {
      view.setUint8(at++, OP_DELETE_RANGE);
      bytes(op.start);
      view.setUint8(at++, op.endExclusive ? 1 : 0);
      if (op.endExclusive) bytes(op.endExclusive);
      u64(op.through);
      continue;
    }
    view.setUint8(at++, op.type === "put" ? OP_PUT : OP_DEL);
    bytes(op.key);
    if (op.type === "put") bytes(op.value);
  }
  return out.buffer;
}

/** The ops of `record` with each range delete's `through` resolved against `seq`. */
export function resolveOps(ops: readonly CheckedOp[], seq: Seq): readonly CheckedOp[] {
  if (!ops.some((op) => op.type === "deleteRange")) return ops;
  return ops.map((op) => (op.type === "deleteRange" ? { ...op, through: resolveThrough(op.through, seq) } : op));
}

/**
 * The ops of the row at `seq`: none when its header names another seq
 * (`rowValid`). The whole row is parsed first, so a corrupt row fails the
 * same with or without a header. Keys and values are views into the row's
 * buffer, which nothing else holds. Exported for the decoder fuzz tests
 * (`packages/kv/fuzz/`).
 */
export function decodeOps(raw: unknown, seq: Seq): CheckedOp[] {
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
  const seqOf = (what: string): Seq => {
    const stored = take(8);
    const n = new DataView(stored.buffer, stored.byteOffset, 8).getBigUint64(0, true);
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new CommitError(`corrupt wal row: ${what}`);
    return asSeq(Number(n));
  };
  let validAt: Seq | undefined;
  if (bytes[0] === ROW_VALID_AT) {
    at = 1;
    validAt = seqOf("valid at");
  }
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
      const through = seqOf("through");
      if (end && compareBytes(key, end) >= 0) throw new CommitError("corrupt wal row: empty range");
      ops.push({
        type: "deleteRange",
        start: key,
        ...(end ? { endExclusive: end } : {}),
        through: resolveThrough(through, seq),
      });
    } else {
      throw new CommitError(`corrupt wal op ${type}`);
    }
  }
  return rowValid(validAt, seq) ? ops : [];
}

/** How an open treats a database that does not exist. */
type OpenHow = {
  /** Makes the stores of a database the open creates. Without it, such an open aborts its upgrade and resolves undefined. */
  readonly create?: (db: IDBDatabase) => void;
  /** Asks for an upgrade to this version (`destroyDb`'s fence). Every other open is version-less. */
  readonly version?: number;
  /** Runs once another context's upgrade or delete closed the connection. */
  readonly onAskedToClose?: () => void;
};

/**
 * Open IndexedDB database `name`. A version-less open takes the database at
 * whatever version a fence left it. An open without `create` that would
 * create the database aborts its upgrade, so the browser drops it, and
 * resolves undefined. The connection closes on `versionchange`, so it never
 * blocks another context's upgrade or delete.
 */
export function openDatabase(name: string, how: OpenHow): Promise<IDBDatabase | undefined> {
  return new Promise((resolve, reject) => {
    const req = how.version === undefined ? indexedDB.open(name) : indexedDB.open(name, how.version);
    let refused = false;
    req.onupgradeneeded = (ev) => {
      if (ev.oldVersion !== 0) return;
      if (how.create) return how.create(req.result);
      refused = true;
      req.transaction?.abort();
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        how.onAskedToClose?.();
      };
      resolve(db);
    };
    req.onerror = () => {
      if (refused) return resolve(undefined);
      const cause = req.error;
      const detail = cause ? ` (${cause.name}: ${cause.message})` : "";
      reject(new StorageUnavailableError(`the browser's IndexedDB store failed to open${detail}`, { cause }));
    };
  });
}

function createWalStores(db: IDBDatabase): void {
  db.createObjectStore(META_STORE);
  db.createObjectStore(WAL_STORE, { autoIncrement: true });
}

export function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new CommitError("idb request failed"));
  });
}

export function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new CommitError("idb tx failed"));
    tx.onabort = () => reject(tx.error ?? new CommitError("idb tx aborted"));
  });
}

/**
 * The head, the seq of the last committed batch: the last key in `wal`, or
 * `ingestedThrough` when no record is past it. Nothing stores the head. An
 * append writes only its record, and recovery and destroy, which move the
 * head past the records, drop them all and set `ingestedThrough` to the new
 * head (`adopt`, `emptyWal`).
 *
 * `after` is a seq the head has reached. Seqs above `ingestedThrough` are
 * gapless, so the head is past `after` only when `after + 1` is a key, and
 * the last key is read only then. In Chrome a range read past the last
 * record steps over every row deleted since IndexedDB last compacted, and a
 * flush deletes thousands of folded records at once.
 */
async function headOf(tx: IDBTransaction, after: Seq): Promise<Seq> {
  const wal = tx.objectStore(WAL_STORE);
  if ((await reqToPromise(wal.getKey(nextSeq(after)))) === undefined) return after;
  const last = await reqToPromise(wal.openKeyCursor(IDBKeyRange.lowerBound(after, true), "prev"));
  return asSeq(Math.max(num(last?.key), after));
}

async function readMeta(tx: IDBTransaction): Promise<WalMeta> {
  const meta = tx.objectStore(META_STORE);
  const [ingestedThrough, generation, top, destroyedTop] = await Promise.all([
    metaSeq(meta, META_INGESTED),
    metaGenerationOpt(meta, META_GENERATION),
    metaGeneration(meta, META_TOP),
    metaGeneration(meta, META_DESTROYED_TOP),
  ]);
  return { head: await headOf(tx, ingestedThrough), ingestedThrough, generation, top, destroyedTop };
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
  after: Seq,
  head: Seq,
): Promise<WalRecord[]> {
  const chunks: Promise<WalRecord[]>[] = [];
  for (let lo = after + 1; lo <= head; lo += READ_CHUNK) {
    const hi = Math.min(head, lo + READ_CHUNK - 1);
    chunks.push(
      reqToPromise(wal.getAll(IDBKeyRange.bound(lo, hi))).then((values) => {
        if (values.length !== hi - lo + 1) {
          throw new CommitError(`wal gap in seqs ${lo}..${hi}`);
        }
        return values.map((value, i) => ({ seq: asSeq(lo + i), ops: decodeOps(value, asSeq(lo + i)) }));
      }),
    );
  }
  return (await Promise.all(chunks)).flat();
}

/**
 * What an op counts toward a flush chunk at least. The encoder keeps a few
 * dozen bytes per entry whatever its size, so a chunk of tiny ops would
 * otherwise cost far more memory than its op bytes say.
 */
const FLUSH_MIN_OP_BYTES = 32;

/**
 * The oldest records with `after < seq <= head` whose op bytes fit in
 * `maxBytes`, and at least one. It reads one record first, then sizes each
 * read from the bytes per record so far, so a WAL of large records is never
 * read far past the cap. A record that would not fit is read and left for the
 * next call. An op counts as at least `minOpBytes`.
 */
async function readRecordsUpTo(
  wal: IDBObjectStore,
  after: Seq,
  head: Seq,
  maxBytes: number,
  minOpBytes = 0,
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
      const at = asSeq(lo + i);
      const ops = decodeOps(value, at);
      const size = Math.max(opsBytes(ops), ops.length * minOpBytes);
      if (records.length > 0 && bytes + size > maxBytes) return records;
      records.push({ seq: at, ops });
      bytes += size;
    }
    lo = hi + 1;
    const fits = ((maxBytes - bytes) * records.length) / Math.max(bytes, 1);
    span = Math.max(1, Math.min(READ_CHUNK, Math.floor(fits)));
  }
  return records;
}

async function readTail(tx: IDBTransaction, since: Seq, held?: Generation): Promise<WalTail> {
  const meta = tx.objectStore(META_STORE);
  const [generation, ingestedThrough] = await Promise.all([
    metaGeneration(meta, META_GENERATION),
    metaSeq(meta, META_INGESTED),
  ]);
  const copy = held === undefined || held === generation ? undefined : reqToPromise<Uint8Array | undefined>(meta.get(META_MANIFEST));
  const after = asSeq(Math.max(since, ingestedThrough));
  const head = await headOf(tx, after);
  const records = await readRecords(tx.objectStore(WAL_STORE), after, head);
  return { head, generation, ingestedThrough, records, manifest: await copy };
}

/**
 * Move the key generator of `wal` to `head + 1`, so the next append takes
 * that seq. Every writer that moves the head past the last key in `wal`
 * calls this in the same transaction. `head` is a key the store does not
 * hold. An explicit key moves the generator, and the delete does not move
 * it back.
 */
function passKeyGenerator(wal: IDBObjectStore, head: Seq): void {
  wal.add(EMPTY_RECORD, head);
  wal.delete(head);
}

function isQuota(err: unknown): boolean {
  return codeOfError(err) === "quota";
}

function storageFull(cause: unknown): StorageFullError {
  return new StorageFullError("the browser refused the write: the origin's storage is full", { cause });
}

type Decide<R> = (tail: WalTail) => { readonly ops: readonly CheckedOp[]; readonly result: R } | undefined;

type Appended<R> = {
  readonly seq: Seq | undefined;
  readonly ops: readonly CheckedOp[];
  /** The row written: `encodeOps(ops)`. Empty when nothing was. */
  readonly record: ArrayBuffer;
  readonly result: R;
};

type GroupEntry = {
  readonly record: ArrayBuffer;
  readonly resolve: (seq: Seq) => void;
  readonly reject: (err: unknown) => void;
};

type Group = {
  readonly tx: IDBTransaction;
  /** Each entry with the `add` whose result is its seq. */
  readonly adds: { readonly entry: GroupEntry; readonly add: IDBRequest<IDBValidKey> }[];
  /** True until the commit starts, in a microtask of the turn that opened the transaction. */
  joinable: boolean;
};

/**
 * One connection to the IDB database every tab of a database name shares.
 * The WAL is the only durable copy of a write until ingest folds it into an
 * SST. This is what a tab and the host both need: the meta record and the
 * recovery write. `TabWal` adds the tab's reads and appends. The host's
 * transactions are the functions below it.
 *
 * Only `TabWal.open`, which only `openDb` calls, creates the database.
 */
export class IdBWal {
  constructor(
    readonly dbName: DbName,
    protected connection: IDBDatabase,
  ) {}

  /** A connection to `opfs-lsm-wal/<dbName>`. */
  get db(): IDBDatabase {
    return this.connection;
  }

  /** The host's open: undefined when `opfs-lsm-wal/<name>` does not exist. Creates nothing. */
  static async openExisting(dbName: DbName): Promise<IdBWal | undefined> {
    const db = await openDatabase(idbName(dbName), {});
    return db && new IdBWal(dbName, db);
  }

  close(): void {
    this.db.close();
  }

  async meta(): Promise<WalMeta> {
    return readMeta(this.db.transaction([WAL_STORE, META_STORE], "readonly"));
  }
}

/**
 * A tab's connection: it reads the tail and appends. Each tab keeps its own
 * memtable in memory. Ack = transaction complete.
 */
export class TabWal extends IdBWal {
  /** WAL records this handle committed. `readStats` in `@opfs-lsm/kv/testing` reports it, and the bench reads it from an `openDb` handle. */
  appendedRecords = 0;
  /** Encoded bytes of those records. */
  appendedBytes = 0;
  /** The group whose transaction is open, from its creation to its end. */
  private open: Group | undefined = undefined;
  /** Appends that arrived after `open` went inactive: the next group. */
  private queued: GroupEntry[] = [];
  private closing = false;
  /**
   * Set while the connection is replaced after a quota abort. No write
   * transaction starts meanwhile: Firefox refuses writes on a connection
   * that saw one.
   */
  private recovering: Promise<void> | undefined = undefined;

  private constructor(
    dbName: DbName,
    db: IDBDatabase,
    private readonly onAskedToClose: (() => void) | undefined,
    private readonly makeRoom: (() => Promise<void>) | undefined,
  ) {
    super(dbName, db);
  }

  /**
   * The tab's open, the one open that creates the database. The connection
   * closes when another context upgrades or deletes the database
   * (`destroyDb`), then `onAskedToClose` runs, so the handle closes itself.
   * `makeRoom` has the host release the reserve. With it, an append the
   * browser refuses for lack of space runs once more.
   */
  static async open(dbName: DbName, onAskedToClose?: () => void, makeRoom?: () => Promise<void>): Promise<TabWal> {
    const db = await openDatabase(idbName(dbName), { create: createWalStores, ...(onAskedToClose ? { onAskedToClose } : {}) });
    return new TabWal(dbName, db!, onAskedToClose, makeRoom);
  }

  /**
   * What follows a transaction the browser aborted for lack of space: with
   * `release`, the host releases the reserve, then the connection is
   * replaced. The appends that failed together share one recovery, so one
   * call to the host. False when it failed.
   */
  private recover(release: boolean): Promise<boolean> {
    const makeRoom = release ? this.makeRoom : undefined;
    this.recovering ??= (async () => {
      await makeRoom?.();
      await this.reconnect();
    })().finally(() => {
      this.recovering = undefined;
      this.next();
    });
    return this.recovering.then(
      () => true,
      () => false,
    );
  }

  private async reconnect(): Promise<void> {
    const fresh = await openDatabase(idbName(this.dbName), this.onAskedToClose ? { onAskedToClose: this.onAskedToClose } : {});
    if (!fresh) throw new ClosedError("database was destroyed");
    const spent = this.connection;
    this.connection = fresh;
    // Its transactions in flight still finish.
    spent.close();
  }

  /** Closes the connection once the groups already started or queued commit. */
  override close(): void {
    this.closing = true;
    if (!this.open && !this.recovering) this.db.close();
  }

  /**
   * The tail after `since`, from one readonly transaction, with the
   * `manifest` copy when the recorded generation is not `held`.
   */
  async tail(since: Seq, held?: Generation): Promise<WalTail> {
    // The reads are the result. Waiting for `complete` as well is one more trip.
    const tx = this.db.transaction([WAL_STORE, META_STORE], "readonly");
    const tail = await readTail(tx, since, held);
    return tail;
  }

  /**
   * In one readwrite transaction, read the tail after `since`, let `decide`
   * choose a batch, and append it under the next seq. `decide` runs
   * synchronously inside the transaction. Returning undefined writes nothing,
   * and a throw aborts the transaction and rethrows. A transaction the
   * browser refuses for lack of space runs once more, `decide` included,
   * after the host released the reserve, and then rejects with
   * `StorageFullError`.
   */
  async appendAfter<R>(since: Seq, decide: Decide<R>): Promise<Appended<R> | undefined> {
    while (this.recovering) await this.recovering.catch(() => undefined);
    try {
      return await this.appendOnce(since, decide);
    } catch (err) {
      if (!isQuota(err)) throw err;
      let cause = err;
      if (this.makeRoom && (await this.recover(true))) {
        try {
          return await this.appendOnce(since, decide);
        } catch (again) {
          if (!isQuota(again)) throw again;
          cause = again;
        }
      }
      await this.recover(false);
      throw storageFull(cause);
    }
  }

  private async appendOnce<R>(since: Seq, decide: Decide<R>): Promise<Appended<R> | undefined> {
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
    const seq = nextSeq(tail.head);
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
   * Append `record` (`encodeOps`) under the key IndexedDB assigns, by group
   * commit: the append that opens a group's transaction and the ones issued
   * synchronously after it join it, and appends that arrive while it
   * commits form the next group.
   * A group is one readwrite transaction with one `add` per record, so each
   * record keeps its own seq, and the records commit or abort together.
   * Each caller resolves when its group commits, in seq order; a failed
   * group rejects every caller in it. The key generator is one past the
   * head (`passKeyGenerator`), and an aborted transaction gives its keys
   * back, so committed seqs stay gapless. A group the browser refuses for
   * lack of space commits once more, as it was, after the host released
   * the reserve, and then rejects every caller with `StorageFullError`.
   */
  append(record: ArrayBuffer): Promise<Seq> {
    return new Promise((resolve, reject) => {
      const entry: GroupEntry = { record, resolve, reject };
      if (this.open?.joinable) this.join(this.open, entry);
      else if (this.open || this.recovering) this.queued.push(entry);
      else this.commitGroup([entry]);
    });
  }

  private join(group: Group, entry: GroupEntry): void {
    group.adds.push({ entry, add: group.tx.objectStore(WAL_STORE).add(entry.record) });
  }

  private commitGroup(entries: GroupEntry[], retried = false): void {
    let tx: IDBTransaction;
    try {
      tx = this.db.transaction(WAL_STORE, "readwrite");
    } catch {
      // Only a connection that closed refuses a transaction here: another
      // context's upgrade or delete, or the browser, closed it while these
      // appends queued.
      const err = new ClosedError("database is closed");
      this.open = undefined;
      for (const entry of entries) entry.reject(err);
      this.next();
      return;
    }
    // A retried group takes no new append: it is the refused group, as it was.
    const group: Group = { tx, adds: [], joinable: !retried };
    this.open = group;
    // A microtask, so the appends issued synchronously after this one join.
    // Without the commit, Chrome waits for the adds' success events to
    // reach the tab before it commits: one more round trip per group.
    queueMicrotask(() => {
      group.joinable = false;
      tx.commit();
    });
    for (const entry of entries) this.join(group, entry);
    txDone(tx).then(
      () => {
        for (const { entry } of group.adds) {
          this.appendedRecords += 1;
          this.appendedBytes += entry.record.byteLength;
        }
        this.finish(group);
        for (const { entry, add } of group.adds) entry.resolve(asSeq(add.result as number));
      },
      (err: unknown) => {
        if (!isQuota(err)) {
          this.finish(group);
          for (const { entry } of group.adds) entry.reject(err);
          return;
        }
        const retry = !retried && this.makeRoom !== undefined;
        const refused = group.adds.map(({ entry }) => entry);
        // `open` stays this group meanwhile, so the appends that arrive queue behind it and keep their order.
        void this.recover(retry).then((ready) => {
          if (retry && ready) return this.commitGroup(refused, true);
          this.finish(group);
          for (const entry of refused) entry.reject(storageFull(err));
        });
      },
    );
  }

  private finish(group: Group): void {
    if (this.open === group) this.open = undefined;
    this.next();
  }

  /** Start the next group from the queue, or close when `close` waits on it. */
  private next(): void {
    if (this.open || this.recovering) return;
    const entries = this.queued;
    this.queued = [];
    if (entries.length > 0) this.commitGroup(entries);
    else if (this.closing) this.db.close();
  }
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
 *   the WAL never held. Every record is dropped, `head` moves up by at
 *   least one, and `ingestedThrough` moves to it: the database is the
 *   manifest alone, and no seq names both that state and the one before.
 * `head` never moves down, so a seq is never reused.
 */
export async function adopt(wal: IdBWal, pairing: {
  readonly expect: WalMeta;
  readonly generation: Generation;
  readonly through: Seq;
  readonly floor: Seq;
  readonly top: Generation;
}): Promise<boolean> {
  const { expect, generation, through, floor, top } = pairing;
  const tx = wal.db.transaction([WAL_STORE, META_STORE], "readwrite");
  const done = txDone(tx);
  const meta = tx.objectStore(META_STORE);
  const records = tx.objectStore(WAL_STORE);
  const now = await readMeta(tx);
  if (!sameMeta(now, expect)) {
    await done;
    return false;
  }
  const { head, ingestedThrough: ingested, top: knownTop } = now;
  const above =
    head > through
      ? await reqToPromise(records.getAll(IDBKeyRange.bound(nextSeq(through), head)))
      : [];
  const past = asSeq(Math.max(head, through, floor));
  const follows = past === head && (through >= ingested || above.length === head - through);
  // Dropping the records changes what the database reads, so the head moves
  // too: a tab at the old head then reads the tail as one it is behind, and
  // a row valid at the old `head + 1` (`rowValid`) never takes that seq.
  const nextHead = follows ? head : asSeq(Math.max(past, nextSeq(head)));
  let nextIngested: Seq = through;
  if (follows) {
    records.delete(IDBKeyRange.upperBound(Math.min(ingested, through)));
  } else {
    // No record can follow the manifest: drop them all, and start the
    // WAL past every seq handed out.
    nextIngested = nextHead;
    records.delete(IDBKeyRange.upperBound(head));
  }
  if (nextHead > head) passKeyGenerator(records, nextHead);
  meta.put(nextIngested, META_INGESTED);
  meta.put(generation, META_GENERATION);
  meta.put(Math.max(knownTop, top, generation), META_TOP);
  await done;
  return true;
}

/**
 * Record generation 0 in a WAL database that records none and holds no
 * record: what `adopt` writes there for the empty manifest. Writes nothing
 * and returns false unless `meta` still reads `expect`.
 */
export async function recordNew(wal: IdBWal, expect: WalMeta): Promise<boolean> {
  const tx = wal.db.transaction([WAL_STORE, META_STORE], "readwrite");
  const done = txDone(tx);
  const same = sameMeta(await readMeta(tx), expect);
  if (same) {
    const meta = tx.objectStore(META_STORE);
    meta.put(expect.ingestedThrough, META_INGESTED);
    meta.put(GENERATION_NONE, META_GENERATION);
    meta.put(expect.top, META_TOP);
  }
  await done;
  return same;
}

/**
 * Empty the database: drop every record, and record generation 0 with
 * `head` and `ingestedThrough` at `head`, and `topGeneration` and
 * `destroyedTop` at `top`. Writes nothing and returns false unless `meta`
 * still reads `expect`. Resolves once the commit is on disk (durability
 * "strict"), so no power loss keeps a file removed after it and loses it.
 */
export async function emptyWal(
  wal: IdBWal,
  emptied: { readonly expect: WalMeta; readonly head: Seq; readonly top: Generation },
): Promise<boolean> {
  const { expect, head, top } = emptied;
  const tx = wal.db.transaction([WAL_STORE, META_STORE], "readwrite", { durability: "strict" });
  const done = txDone(tx);
  const now = await readMeta(tx);
  if (!sameMeta(now, expect)) {
    await done;
    return false;
  }
  const meta = tx.objectStore(META_STORE);
  const records = tx.objectStore(WAL_STORE);
  records.delete(IDBKeyRange.upperBound(now.head));
  if (head > now.head) passKeyGenerator(records, head);
  meta.put(head, META_INGESTED);
  meta.put(GENERATION_NONE, META_GENERATION);
  meta.put(top, META_TOP);
  meta.put(top, META_DESTROYED_TOP);
  await done;
  return true;
}

/** Record `generation` and its `manifest` bytes unless a newer one is already recorded. */
export async function raiseGeneration(wal: IdBWal, generation: Generation, manifest: Uint8Array): Promise<void> {
  const tx = wal.db.transaction(META_STORE, "readwrite");
  const meta = tx.objectStore(META_STORE);
  const recorded = await metaGenerationOpt(meta, META_GENERATION);
  if (recorded === undefined || generation > recorded) {
    meta.put(generation, META_GENERATION);
    meta.put(manifest, META_MANIFEST);
  }
  await txDone(tx);
}

export async function getIngestedThrough(wal: IdBWal): Promise<Seq> {
  const tx = wal.db.transaction(META_STORE, "readonly");
  const through = await metaSeq(tx.objectStore(META_STORE), META_INGESTED);
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
  const through = await metaSeq(tx.objectStore(META_STORE), META_INGESTED);
  const head = await headOf(tx, through);
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
 * the cap comes alone. An op counts as at least `FLUSH_MIN_OP_BYTES`.
 */
export async function listUningested(wal: IdBWal, limit: { readonly maxBytes: number }): Promise<WalRecord[]> {
  const tx = wal.db.transaction([WAL_STORE, META_STORE], "readonly");
  const done = txDone(tx);
  const meta = tx.objectStore(META_STORE);
  const through = await metaSeq(meta, META_INGESTED);
  const head = await headOf(tx, through);
  const store = tx.objectStore(WAL_STORE);
  const records = await readRecordsUpTo(store, through, head, limit.maxBytes, FLUSH_MIN_OP_BYTES);
  await done;
  return records;
}

/**
 * Mark seqs <= through as ingested and record `generation` and its
 * `manifest` bytes in the same transaction. A tab that has not read them
 * jumps to the SST for that generation. Deletes the records the previous
 * ingest folded: the ones this ingest folded stay until the next, so a
 * power loss that keeps this commit and loses the new manifest can still
 * recover them (design.md, "Recovery").
 */
export async function advanceIngested(
  wal: IdBWal,
  folded: { readonly through: Seq; readonly generation: Generation; readonly manifest: Uint8Array },
): Promise<void> {
  const { through, generation, manifest } = folded;
  const tx = wal.db.transaction([WAL_STORE, META_STORE], "readwrite");
  const done = txDone(tx);
  const meta = tx.objectStore(META_STORE);
  const [existing, prevGen] = await Promise.all([
    metaSeq(meta, META_INGESTED),
    metaGeneration(meta, META_GENERATION),
  ]);
  if (through > existing) {
    tx.objectStore(WAL_STORE).delete(IDBKeyRange.upperBound(existing));
    meta.put(through, META_INGESTED);
    if (generation >= prevGen) {
      meta.put(generation, META_GENERATION);
      meta.put(manifest, META_MANIFEST);
    }
  }
  await done;
}

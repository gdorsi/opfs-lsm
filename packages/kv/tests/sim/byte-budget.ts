import type { FileWriter, RemovableFs } from "../../src/opfs/async-fs.js";

function quotaExceeded(): DOMException {
  return new DOMException("over the byte budget", "QuotaExceededError");
}

/**
 * A folder under an origin's byte limit, charged the way the browsers
 * charge OPFS: a file's bytes count from the write that stages them, a write
 * past the limit fails with `QuotaExceededError` and leaves the target as
 * it was, and a remove gives the bytes back at once.
 */
export class BudgetFs implements RemovableFs {
  private readonly sizes = new Map<string, number>();
  private staged = 0;
  /** Writes refused so far. */
  refused = 0;

  constructor(
    private readonly inner: RemovableFs,
    /** The origin's limit. A test moves it to fill the origin or to free space elsewhere. */
    public limit: number,
  ) {}

  /** Bytes of the published files. */
  get used(): number {
    let n = 0;
    for (const size of this.sizes.values()) n += size;
    return n;
  }

  /** Bytes a write can still take. */
  get free(): number {
    return this.limit - this.used - this.staged;
  }

  /** Bytes of the published file at `path`, 0 when there is none. */
  sizeOf(path: string): number {
    return this.sizes.get(path) ?? 0;
  }

  read(path: string, offset: number, length: number) {
    return this.inner.read(path, offset, length);
  }

  open(path: string) {
    return this.inner.open(path);
  }

  list(dir: string) {
    return this.inner.list(dir);
  }

  async remove(path: string): Promise<void> {
    await this.inner.remove(path);
    this.sizes.delete(path);
  }

  async removeUnlessOpen(path: string): Promise<boolean> {
    const removed = await this.inner.removeUnlessOpen(path);
    if (removed) this.sizes.delete(path);
    return removed;
  }

  async removeFolder(): Promise<void> {
    await this.inner.removeFolder();
    this.sizes.clear();
  }

  async create(path: string): Promise<FileWriter> {
    const writer = await this.inner.create(path);
    let mine = 0;
    const unstage = () => {
      this.staged -= mine;
      mine = 0;
    };
    return {
      write: async (bytes) => {
        if (bytes.byteLength > this.free) {
          this.refused += 1;
          unstage();
          await writer.abort();
          throw quotaExceeded();
        }
        await writer.write(bytes);
        mine += bytes.byteLength;
        this.staged += bytes.byteLength;
      },
      finish: async () => {
        await writer.finish();
        this.sizes.set(path, mine);
        unstage();
      },
      abort: async () => {
        unstage();
        await writer.abort();
      },
    };
  }
}

type Aborting = IDBTransaction & { _abort(errorName: string): void };

/**
 * Refuse the WAL appends of database `name` while `origin` has no room for
 * them, the way Chromium and Firefox do at the limit: every `add` succeeds,
 * then the transaction aborts with `QuotaExceededError`. A connection that
 * saw such an abort starts no other write transaction, as Firefox did when
 * measured. A seam over fake-indexeddb, with no change to the product. It
 * charges the origin nothing: the WAL is small next to the run files.
 * Returns the restore.
 */
export function refuseWalAppends(name: string, origin: { readonly free: number }): () => void {
  const walName = `opfs-lsm-wal/${name}`;
  const store = globalThis.IDBObjectStore.prototype;
  const database = globalThis.IDBDatabase.prototype;
  const { add } = store;
  const { transaction } = database;
  const groups = new WeakMap<IDBTransaction, { waiting: number; refused: boolean }>();
  const spent = new WeakSet<IDBDatabase>();
  database.transaction = function (this: IDBDatabase, ...args: Parameters<IDBDatabase["transaction"]>) {
    if (spent.has(this) && args[1] === "readwrite") {
      throw new DOMException("this connection saw a quota abort", "InvalidStateError");
    }
    return transaction.apply(this, args);
  };
  store.add = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    const req = add.call(this, value, key);
    const tx = this.transaction;
    if (tx.db.name !== walName || this.name !== "wal" || !(value instanceof ArrayBuffer)) return req;
    const group = groups.get(tx) ?? { waiting: 0, refused: false };
    groups.set(tx, group);
    group.waiting += 1;
    group.refused ||= value.byteLength > origin.free;
    req.addEventListener("success", () => {
      if (--group.waiting > 0 || !group.refused) return;
      spent.add(tx.db);
      (tx as Aborting)._abort("QuotaExceededError");
    });
    return req;
  };
  return () => {
    store.add = add;
    database.transaction = transaction;
  };
}

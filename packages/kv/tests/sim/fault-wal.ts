import { TabWal } from "../../src/idb/wal.js";
import { checkDbName } from "../../src/check.js";
import type { DurableOp, Faults, IdbMutation } from "./fault-fs.js";
import { walStore } from "./check-database.js";

/**
 * The IndexedDB side of `Faults`, as a harness seam over fake-indexeddb
 * with no change to `IdBWal`: `installFaultWal` wraps `put`, `add` and
 * `delete` of `IDBObjectStore.prototype`, `commit` of
 * `IDBTransaction.prototype` and `deleteDatabase` of
 * `IDBFactory.prototype`. For a database registered with `traceWal`, its
 * WAL database and its row in `opfs-lsm-destroyed` are traced, as one
 * sequence of IndexedDB ops (Chrome keeps both in one LevelDB):
 * - every readwrite transaction that writes is a fault site, at its first
 *   write. A fault aborts it before it commits (a microtask later, so the
 *   engine's synchronous writes in the same task still run), the way a
 *   failed commit or `QuotaExceededError` does. A faulted transaction that
 *   calls `commit()` aborts there instead, when it has not aborted yet,
 *   since `abort()` throws once a commit has started;
 * - every committed one is one durable op, recorded at `complete` with its
 *   writes, so a crash state can replay a prefix of them (`materializeWal`).
 *   A "strict" one is marked, since no power loss drops it once a later op
 *   ran (`powerCuts`);
 * - a deletion of the WAL database is one durable op, `drop`. An upgrade
 *   that only raises the version records nothing.
 */

const registered = new Map<string, Faults>();
const walName = (name: string) => `opfs-lsm-wal/${name}`;
/** The database and store of the rows `destroyDb` leaves (src/idb/destroyed.ts). */
const DESTROYED_DB = "opfs-lsm-destroyed";
const DESTROYED_STORE = "destroyed";

/** Trace and fault the WAL of database `name` with `faults`. Returns the unregister. */
export function traceWal(name: string, faults: Faults): () => void {
  registered.set(walName(name), faults);
  return () => registered.delete(walName(name));
}

type TxState = { readonly faults: Faults; readonly muts: IdbMutation[]; verdict: "ok" | "fail" | "crash" };
const txs = new WeakMap<IDBTransaction, TxState>();

/** Patch the object store prototype. Returns the restore. */
export function installFaultWal(): () => void {
  const proto = globalThis.IDBObjectStore.prototype;
  const { put, add, delete: del } = proto;

  /**
   * The transaction's state, or undefined when it is not traced. Starts it on
   * its first write. A row of `opfs-lsm-destroyed` is traced by its key, the
   * database name.
   */
  const stateOf = (store: IDBObjectStore, key?: IDBValidKey | IDBKeyRange): TxState | undefined => {
    const tx = store.transaction;
    if (tx.mode !== "readwrite") return undefined;
    let state = txs.get(tx);
    if (state) return state;
    const row = tx.db.name === DESTROYED_DB;
    const faults = registered.get(row ? walName(String(key)) : tx.db.name);
    if (!faults) return undefined;
    state = { faults, muts: [], verdict: faults.hit("idb-write", `idb commit over [${[...tx.objectStoreNames].join(", ")}]`) };
    txs.set(tx, state);
    const s = state;
    if (s.verdict !== "ok") {
      queueMicrotask(() => {
        try {
          tx.abort();
        } catch {
          // Already finished.
        }
      });
    } else {
      tx.addEventListener("complete", () => {
        if (s.muts.length === 0) return;
        const label = row ? `destroyed row ${s.muts.map((m) => m.kind).join(", ")}` : labelOf(s.muts);
        const db = row ? { db: "destroyed" as const } : {};
        s.faults.record(tx.durability === "strict" ? { store: "idb", label, muts: s.muts, strict: true, ...db } : { store: "idb", label, muts: s.muts, ...db });
      });
    }
    return state;
  };

  proto.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    const state = stateOf(this, key);
    const req = put.call(this, value, key);
    if (state) track(state, this.name, value, key, req);
    return req;
  };
  proto.add = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    const state = stateOf(this, key);
    const req = add.call(this, value, key);
    if (state) track(state, this.name, value, key, req);
    return req;
  };
  proto.delete = function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
    const state = stateOf(this, key);
    const req = del.call(this, key);
    if (state) state.muts.push({ kind: "delete", store: this.name, key });
    return req;
  };
  const txProto = globalThis.IDBTransaction.prototype;
  const { commit } = txProto;
  txProto.commit = function (this: IDBTransaction) {
    const state = txs.get(this);
    if (!state || state.verdict === "ok") return commit.call(this);
    try {
      this.abort();
    } catch {
      // The fault's own abort ran first.
    }
  };
  const factoryProto = globalThis.IDBFactory.prototype;
  const { deleteDatabase } = factoryProto;
  factoryProto.deleteDatabase = function (this: IDBFactory, name: string) {
    const req = deleteDatabase.call(this, name);
    const faults = registered.get(name);
    if (faults) req.addEventListener("success", () => faults.record({ store: "idb", label: "delete the WAL database", muts: [], drop: true }));
    return req;
  };
  return () => {
    proto.put = put;
    proto.add = add;
    proto.delete = del;
    txProto.commit = commit;
    factoryProto.deleteDatabase = deleteDatabase;
  };
}

function track(state: TxState, store: string, value: unknown, key: IDBValidKey | undefined, req: IDBRequest<IDBValidKey>): void {
  // IndexedDB clones the value when the call is made.
  const mut: { kind: "put"; store: string; key: IDBValidKey; value: unknown } = {
    kind: "put",
    store,
    key: key ?? -1,
    value: structuredClone(value),
  };
  state.muts.push(mut);
  // An `add` with no key gets the key generator's.
  if (key === undefined) req.addEventListener("success", () => (mut.key = req.result));
}

function labelOf(muts: readonly IdbMutation[]): string {
  const meta = new Map<string, unknown>();
  for (const m of muts) if (m.store === "meta" && m.kind === "put") meta.set(String(m.key), m.value);
  // Before the append: an adopt that moves the head also adds a row, to move the key generator.
  if (meta.has("topGeneration") && meta.has("ingestedThrough")) {
    return `adopt generation ${String(meta.get("generation"))} ingestedThrough ${String(meta.get("ingestedThrough"))}`;
  }
  const appended = muts.find((m) => m.store === "wal" && m.kind === "put");
  if (appended) return `append seq ${String(appended.key)}`;
  if (meta.has("ingestedThrough")) return `advanceIngested through ${String(meta.get("ingestedThrough"))} gen ${String(meta.get("generation"))}`;
  if (meta.has("generation")) return `raiseGeneration ${String(meta.get("generation"))}`;
  return `meta ${[...meta.keys()].join(",")}`;
}

/** Every row of the WAL database `name`, or undefined when it does not exist, for comparing stores. */
export async function dumpWal(name: string): Promise<{ wal: [IDBValidKey, unknown][]; meta: [IDBValidKey, unknown][] } | undefined> {
  if (!(await indexedDB.databases()).some((d) => d.name === walName(name))) return undefined;
  const all = (store: IDBObjectStore) =>
    new Promise<[IDBValidKey, unknown][]>((resolve, reject) => {
      const keys = store.getAllKeys();
      const values = store.getAll();
      values.onsuccess = () => resolve(keys.result.map((k, i) => [k, values.result[i]]));
      values.onerror = () => reject(values.error);
    });
  return walStore(name, "readonly", async (wal, meta) => ({ wal: await all(wal), meta: await all(meta) }));
}

/** The row `opfs-lsm-destroyed` holds for `name`. */
export function destroyedRow(name: string): Promise<unknown> {
  return withDestroyed("readonly", (store) => store.get(name));
}

type IdbOp = Extract<DurableOp, { store: "idb" }>;

/**
 * The stores the first `count` IndexedDB ops of `ops` leave, under `name`:
 * the WAL database holds the commits after its last deletion, and does not
 * exist when a deletion is the last op on it. The row of the traced
 * database in `opfs-lsm-destroyed` goes under `name`.
 */
export async function materializeWal(name: string, ops: readonly DurableOp[], count: number): Promise<void> {
  const kept = ops.filter((op): op is IdbOp => op.store === "idb").slice(0, count);
  let start = 0;
  kept.forEach((op, i) => {
    if (op.drop) start = i + 1;
  });
  const commits = kept.slice(start).filter((op) => op.db === undefined);
  if (start === 0 || commits.length > 0) {
    // The schema, as `TabWal.open` creates it.
    (await TabWal.open(checkDbName(name))).close();
    if (commits.length > 0) {
      await walStore(name, "readwrite", (wal, meta) => {
        for (const { muts } of commits) {
          for (const m of muts) {
            const store = m.store === "wal" ? wal : meta;
            if (m.kind === "put") store.put(m.value, m.key);
            else store.delete(m.key);
          }
        }
        return undefined;
      });
    }
  }
  const rows = kept.filter((op) => op.db === "destroyed");
  await withDestroyed("readwrite", (store) => {
    store.delete(name);
    for (const { muts } of rows) {
      for (const m of muts) {
        if (m.kind === "put") store.put(m.value, name);
        else store.delete(name);
      }
    }
    return undefined;
  });
}

/** `fn` on the store of `opfs-lsm-destroyed`, untraced. Creates the database when it is missing. */
function withDestroyed<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T> | T): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DESTROYED_DB);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(DESTROYED_STORE)) req.result.createObjectStore(DESTROYED_STORE);
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(DESTROYED_STORE, mode);
      const out = fn(tx.objectStore(DESTROYED_STORE));
      tx.oncomplete = () => {
        db.close();
        resolve(out instanceof IDBRequest ? (out.result as T) : out);
      };
      tx.onabort = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
}

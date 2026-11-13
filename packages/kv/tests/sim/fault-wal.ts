import { IdBWal } from "../../src/idb/wal.js";
import { checkDbName } from "../../src/check.js";
import type { Faults, IdbMutation } from "./fault-fs.js";
import { walStore } from "./check-database.js";

/**
 * The IndexedDB side of `Faults`, as a harness seam over fake-indexeddb
 * with no change to `IdBWal`: `installFaultWal` wraps `put`, `add` and
 * `delete` of `IDBObjectStore.prototype`, and `commit` of
 * `IDBTransaction.prototype`. For a database registered with
 * `traceWal`:
 * - every readwrite transaction that writes is a fault site, at its first
 *   write. A fault aborts it before it commits (a microtask later, so the
 *   engine's synchronous writes in the same task still run), the way a
 *   failed commit or `QuotaExceededError` does. A faulted transaction that
 *   calls `commit()` aborts there instead, when it has not aborted yet,
 *   since `abort()` throws once a commit has started;
 * - every committed one is one durable op, recorded at `complete` with its
 *   writes, so a crash state can replay a prefix of them (`materializeWal`).
 *   A "strict" one is marked, since no power loss drops it once a later op
 *   ran (`powerCuts`).
 */

const registered = new Map<string, Faults>();
const walName = (name: string) => `opfs-lsm-wal/${name}`;

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

  /** The transaction's state, or undefined when it is not traced. Starts it on its first write. */
  const stateOf = (store: IDBObjectStore): TxState | undefined => {
    const tx = store.transaction;
    if (tx.mode !== "readwrite") return undefined;
    let state = txs.get(tx);
    if (state) return state;
    const faults = registered.get(tx.db.name);
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
        const label = labelOf(s.muts);
        s.faults.record(tx.durability === "strict" ? { store: "idb", label, muts: s.muts, strict: true } : { store: "idb", label, muts: s.muts });
      });
    }
    return state;
  };

  proto.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    const state = stateOf(this);
    const req = put.call(this, value, key);
    if (state) track(state, this.name, value, key, req);
    return req;
  };
  proto.add = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    const state = stateOf(this);
    const req = add.call(this, value, key);
    if (state) track(state, this.name, value, key, req);
    return req;
  };
  proto.delete = function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
    const state = stateOf(this);
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
  return () => {
    proto.put = put;
    proto.add = add;
    proto.delete = del;
    txProto.commit = commit;
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

/** Every row of the WAL database `name`, for comparing stores. */
export function dumpWal(name: string): Promise<{ wal: [IDBValidKey, unknown][]; meta: [IDBValidKey, unknown][] }> {
  const all = (store: IDBObjectStore) =>
    new Promise<[IDBValidKey, unknown][]>((resolve, reject) => {
      const keys = store.getAllKeys();
      const values = store.getAll();
      values.onsuccess = () => resolve(keys.result.map((k, i) => [k, values.result[i]]));
      values.onerror = () => reject(values.error);
    });
  return walStore(name, "readonly", async (wal, meta) => ({ wal: await all(wal), meta: await all(meta) }));
}

/** A WAL database `name` holding the first `count` IndexedDB commits of `ops`. */
export async function materializeWal(name: string, ops: readonly { store: string; muts?: readonly IdbMutation[] }[], count: number): Promise<void> {
  // The schema, as `IdBWal` creates it.
  (await IdBWal.open(checkDbName(name))).close();
  const commits = ops.filter((op) => op.store === "idb").slice(0, count);
  if (commits.length === 0) return;
  await walStore(name, "readwrite", (wal, meta) => {
    for (const { muts } of commits) {
      for (const m of muts ?? []) {
        const store = m.store === "wal" ? wal : meta;
        if (m.kind === "put") store.put(m.value, m.key);
        else store.delete(m.key);
      }
    }
    return undefined;
  });
}

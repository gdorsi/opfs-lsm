import { keyToString } from "./bytes.js";
import {
  checkBatch,
  checkKey,
  checkValue,
  type CheckedKey,
  type CheckedOp,
} from "./check.js";
import { ClosedError } from "./errors.js";
import type { AppendGuard } from "./idb/wal.js";

export interface Transaction {
  get(key: Uint8Array): Promise<Uint8Array | undefined>;
  put(key: Uint8Array, value: Uint8Array): void;
  delete(key: Uint8Array): void;
  abort(): void;
}

export type TxStore = {
  snapshotHead(): Promise<number>;
  get(key: CheckedKey): Promise<Uint8Array | undefined>;
  commit(
    ops: readonly CheckedOp[],
    opBytes: number,
    guard: AppendGuard,
  ): Promise<void>;
};

/**
 * Interactive transaction with key-based OCC.
 * The snapshot is the WAL head at start. Reads see the latest acked value.
 * Commit fails with ConflictError if a WAL record after the head touches a
 * key this txn read or wrote, so a committed txn read only values at or
 * before the head.
 */
class TxImpl implements Transaction {
  private aborted = false;
  private finished = false;
  private readonly reads = new Map<string, Uint8Array>();
  private readonly writes = new Map<
    string,
    { type: "put" | "del"; key: Uint8Array; value?: Uint8Array }
  >();
  private readonly snapshotHead: Promise<number>;

  constructor(private readonly store: TxStore) {
    this.snapshotHead = store.snapshotHead();
  }

  private ensureActive(): void {
    if (this.aborted) throw new ClosedError("transaction aborted");
    if (this.finished) throw new ClosedError("transaction already finished");
  }

  async get(key: Uint8Array): Promise<Uint8Array | undefined> {
    this.ensureActive();
    await this.snapshotHead;
    const k = checkKey(key);
    const hex = keyToString(k);
    this.reads.set(hex, k);
    const local = this.writes.get(hex);
    if (local) {
      if (local.type === "del") return undefined;
      return new Uint8Array(local.value!);
    }
    return this.store.get(k);
  }

  put(key: Uint8Array, value: Uint8Array): void {
    this.ensureActive();
    const k = checkKey(key);
    const v = checkValue(value);
    this.writes.set(keyToString(k), { type: "put", key: k, value: v });
  }

  delete(key: Uint8Array): void {
    this.ensureActive();
    const k = checkKey(key);
    this.writes.set(keyToString(k), { type: "del", key: k });
  }

  abort(): void {
    this.aborted = true;
    this.writes.clear();
    this.reads.clear();
  }

  wasAborted(): boolean {
    return this.aborted;
  }

  async commit(): Promise<void> {
    this.ensureActive();
    const snapshotHead = await this.snapshotHead;
    this.finished = true;
    if (this.writes.size === 0) return;

    const watched = new Map(this.reads);
    for (const [hex, w] of this.writes) watched.set(hex, w.key);
    const ops = [...this.writes.values()].map((w) =>
      w.type === "put"
        ? { type: "put" as const, key: w.key, value: w.value! }
        : { type: "del" as const, key: w.key },
    );
    const checked = checkBatch(ops);
    let bytes = 0;
    for (const op of checked) {
      bytes += op.key.byteLength;
      if (op.type === "put") bytes += op.value.byteLength;
    }
    await this.store.commit(checked, bytes, {
      snapshotHead,
      watched: [...watched.values()],
    });
  }
}

export async function runTransaction<T>(
  store: TxStore,
  body: (tx: Transaction) => Promise<T> | T,
): Promise<T> {
  const tx = new TxImpl(store);
  try {
    const result = await body(tx);
    if (!tx.wasAborted()) {
      await tx.commit();
    }
    return result;
  } catch (err) {
    tx.abort();
    throw err;
  }
}

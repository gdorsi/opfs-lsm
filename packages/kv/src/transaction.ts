import { keyToString } from "./bytes.js";
import {
  checkBatch,
  checkKey,
  checkValue,
  type CheckedOp,
  type WriterId,
} from "./check.js";
import { ClosedError, ConflictError } from "./errors.js";
import type { IdBWal, MemRow } from "./idb/wal.js";
import type { AsyncFs } from "./opfs/async-fs.js";
import { loadLatestGeneration, loadSstReaders } from "./store/generation.js";
import { lookupPin, pointGet } from "./store/merge.js";
import type { SstReader } from "./store/sst.js";

export interface Transaction {
  get(key: Uint8Array): Promise<Uint8Array | undefined>;
  put(key: Uint8Array, value: Uint8Array): void;
  delete(key: Uint8Array): void;
  abort(): void;
}

type CommitHook = (
  ops: readonly CheckedOp[],
  opBytes: number,
) => Promise<void>;

/**
 * Snapshot-isolated interactive transaction with key-based OCC.
 * Reads see the mem pin taken at start, plus SST readers listed after that
 * pin, plus the local write buffer. Commit fails with ConflictError if a
 * concurrent WAL record after the snapshot touches a key this txn read or wrote.
 */
class TxImpl implements Transaction {
  private aborted = false;
  private finished = false;
  private readonly reads = new Set<string>();
  private readonly writes = new Map<
    string,
    { type: "put" | "del"; key: Uint8Array; value?: Uint8Array }
  >();
  private snapshotHead = 0;
  private rows: readonly MemRow[] = [];
  private readers: readonly SstReader[] = [];
  private readonly ready: Promise<void>;

  constructor(
    private readonly wal: IdBWal,
    private readonly fs: AsyncFs,
    private readonly commitHook: CommitHook,
  ) {
    this.ready = this.loadSnapshot();
  }

  private async loadSnapshot(): Promise<void> {
    const pin = await this.wal.collectMem();
    this.snapshotHead = pin.head;
    this.rows = pin.rows;
    const gen = await loadLatestGeneration(this.fs);
    this.readers = gen ? await loadSstReaders(this.fs, gen) : [];
  }

  private ensureActive(): void {
    if (this.aborted) throw new ClosedError("transaction aborted");
    if (this.finished) throw new ClosedError("transaction already finished");
  }

  async get(key: Uint8Array): Promise<Uint8Array | undefined> {
    this.ensureActive();
    await this.ready;
    const k = checkKey(key);
    const hex = keyToString(k);
    this.reads.add(hex);
    const local = this.writes.get(hex);
    if (local) {
      if (local.type === "del") return undefined;
      return new Uint8Array(local.value!);
    }
    return pointGet(lookupPin(this.rows, k), this.readers, k);
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
    await this.ready;
    this.finished = true;
    if (this.writes.size === 0) return;

    const watched = new Set<string>([...this.reads, ...this.writes.keys()]);
    const newer = await this.wal.listRange(
      this.snapshotHead + 1,
      Number.MAX_SAFE_INTEGER,
    );
    for (const rec of newer) {
      for (const op of rec.ops) {
        if (watched.has(keyToString(op.key))) {
          throw new ConflictError(
            `conflict on key after wal seq ${this.snapshotHead}`,
          );
        }
      }
    }

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
    await this.commitHook(checked, bytes);
  }
}

export async function runTransaction<T>(
  wal: IdBWal,
  fs: AsyncFs,
  _writerId: WriterId,
  commitHook: CommitHook,
  body: (tx: Transaction) => Promise<T> | T,
): Promise<T> {
  const tx = new TxImpl(wal, fs, commitHook);
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

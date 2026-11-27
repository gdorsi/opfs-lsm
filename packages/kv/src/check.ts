import { compareBytes, copyIn } from "./bytes.js";
import { ConstraintError } from "./errors.js";
import { asSeq, type Seq } from "./seq.js";

const LIMITS = {
  keyBytes: 8 * 1024,
  batchBytes: 8 * 1024 * 1024,
} as const;

/**
 * What an op costs in memory besides its key and value bytes: the row object,
 * two Uint8Array views, and for a row this tab wrote, their buffers. V8 in
 * Node holds 290 to 510 bytes. Chrome compresses pointers, so 256 is an
 * estimate for it. The memtable and the batch limit both count it.
 */
export const ROW_OVERHEAD = 256;

export type DbName = string & { readonly __brand: "DbName" };
export type WriterId = string & { readonly __brand: "WriterId" };
export type CheckedKey = Uint8Array & { readonly __brand: "CheckedKey" };
export type CheckedValue = Uint8Array & { readonly __brand: "CheckedValue" };

/**
 * A range delete's `through` resolved against the seq of the record that
 * holds it: always below that seq, so a batch never removes its own writes.
 */
export type ResolvedSeq = Seq & { readonly __resolved: true };

type DeleteRangeOp<Through extends Seq> = {
  readonly type: "deleteRange";
  /** Empty: from the first key. */
  readonly start: CheckedKey;
  readonly endExclusive?: CheckedKey;
  readonly through: Through;
};

type KeyOp =
  | { readonly type: "put"; readonly key: CheckedKey; readonly value: CheckedValue }
  | { readonly type: "del"; readonly key: CheckedKey };

/**
 * An op as the caller asked it: a range delete's `through` is
 * `Number.MAX_SAFE_INTEGER` for every row written before this batch. The
 * WAL row stores it so.
 */
export type CheckedOp = KeyOp | DeleteRangeOp<Seq>;

/** An op of a committed record, whose range deletes are resolved against the record's seq. */
export type ResolvedOp = KeyOp | DeleteRangeOp<ResolvedSeq>;

/** An op as `BatchTx` collects it, before `CheckedBatch` checks it. */
export type BatchOp =
  | { readonly type: "put"; readonly key: Uint8Array; readonly value: Uint8Array }
  | { readonly type: "del"; readonly key: Uint8Array }
  | {
      readonly type: "deleteRange";
      readonly start?: Uint8Array | undefined;
      readonly endExclusive?: Uint8Array | undefined;
      readonly through?: number | undefined;
    };

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function checkDbName(name: string): DbName {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new ConstraintError(
      `database name must match ${NAME_RE}: got ${JSON.stringify(name)}`,
    );
  }
  return name as DbName;
}

/**
 * The copies count elements, so only an array of bytes is stored right; one
 * from another realm counts too. A view of a detached buffer reads as empty,
 * so only an empty one needs the look at its buffer, which V8 has to allocate
 * for a small array.
 */
function assertBuffer(bytes: Uint8Array, label: string): void {
  if (!ArrayBuffer.isView(bytes) || bytes.BYTES_PER_ELEMENT !== 1) {
    throw new ConstraintError(`${label} must be a Uint8Array`);
  }
  if (bytes.byteLength > 0) return;
  const buf = bytes.buffer as ArrayBuffer & { detached?: boolean };
  if (buf.detached === true) {
    throw new ConstraintError(`${label} buffer is detached`);
  }
}

function assertKey(bytes: Uint8Array): void {
  assertBuffer(bytes, "key");
  if (bytes.byteLength > LIMITS.keyBytes) {
    throw new ConstraintError(`key longer than ${LIMITS.keyBytes} bytes`);
  }
}

export function checkKey(bytes: Uint8Array): CheckedKey {
  assertKey(bytes);
  return new Uint8Array(bytes) as CheckedKey;
}

/** A checked copy of a key a write keeps, from the pool its values come from: a key over 64 bytes would otherwise get a buffer of its own. */
function storedKey(bytes: Uint8Array): CheckedKey {
  assertKey(bytes);
  return copyIn(bytes) as CheckedKey;
}

export function checkValue(bytes: Uint8Array): CheckedValue {
  assertBuffer(bytes, "value");
  return copyIn(bytes) as CheckedValue;
}

/** Key and value bytes of an op: a range delete counts its bounds. A missing key counts 0, and its check throws. */
function opBytes(op: BatchOp): number {
  switch (op.type) {
    case "put":
      return (op.key?.byteLength ?? 0) + (op.value?.byteLength ?? 0);
    case "del":
      return op.key?.byteLength ?? 0;
    case "deleteRange":
      return (op.start?.byteLength ?? 0) + (op.endExclusive?.byteLength ?? 0);
  }
}

/**
 * What an op counts at least toward a flush. The encoder keeps a few dozen
 * bytes per entry whatever its size, so a chunk of tiny ops would otherwise
 * cost far more memory than its op bytes say, and ops of no bytes, such as
 * a range delete of everything, would never start a flush.
 */
const FLUSH_MIN_OP_BYTES = 32;

/** What a record's ops count toward the ingest trigger and a flush chunk: their key and value bytes, at least `FLUSH_MIN_OP_BYTES` per op. */
export function flushBytes(ops: readonly CheckedOp[]): number {
  let bytes = 0;
  for (const op of ops) bytes += opBytes(op);
  return Math.max(bytes, ops.length * FLUSH_MIN_OP_BYTES);
}

function checkDeleteRange(op: Extract<BatchOp, { type: "deleteRange" }>): CheckedOp {
  const start = storedKey(op.start ?? new Uint8Array(0));
  const end = op.endExclusive && storedKey(op.endExclusive);
  if (end && compareBytes(start, end) >= 0) {
    throw new ConstraintError("deleteRange needs start below endExclusive");
  }
  if (op.through !== undefined && !(Number.isSafeInteger(op.through) && op.through >= 0)) {
    throw new ConstraintError(`deleteRange through must be a safe integer >= 0: got ${op.through}`);
  }
  return { type: "deleteRange", start, ...(end ? { endExclusive: end } : {}), through: asSeq(op.through ?? Number.MAX_SAFE_INTEGER) };
}

/**
 * A batch's ops, each checked and copied as it is added, so a buffer the
 * caller changes after `tx.put` returns does not reach the batch.
 */
export class CheckedBatch {
  readonly ops: CheckedOp[] = [];
  private bytes = 0;

  add(op: BatchOp): void {
    if (op.type === "put" && op.value == null) {
      throw new ConstraintError("put requires a value");
    }
    // Counted before the copies below, so an oversized value is never copied.
    this.bytes += ROW_OVERHEAD + opBytes(op);
    if (this.bytes > LIMITS.batchBytes) {
      throw new ConstraintError(
        `batch larger than ${LIMITS.batchBytes} bytes, counting ${ROW_OVERHEAD} bytes per op`,
      );
    }
    switch (op.type) {
      case "put":
        this.ops.push({ type: "put", key: storedKey(op.key), value: checkValue(op.value) });
        break;
      case "del":
        this.ops.push({ type: "del", key: storedKey(op.key) });
        break;
      case "deleteRange":
        this.ops.push(checkDeleteRange(op));
        break;
    }
  }
}

export function newWriterId(): WriterId {
  return crypto.randomUUID() as WriterId;
}

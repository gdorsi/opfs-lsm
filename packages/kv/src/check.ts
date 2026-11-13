import { compareBytes } from "./bytes.js";
import { ConstraintError } from "./errors.js";

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

export type CheckedOp =
  | { readonly type: "put"; readonly key: CheckedKey; readonly value: CheckedValue }
  | { readonly type: "del"; readonly key: CheckedKey }
  | {
      readonly type: "deleteRange";
      /** Empty: from the first key. */
      readonly start: CheckedKey;
      readonly endExclusive?: CheckedKey;
      /**
       * As the caller asked, `Number.MAX_SAFE_INTEGER` for every row written
       * before this batch. In a committed record it is resolved against the
       * record's seq and always below it, so a batch never removes its own
       * writes.
       */
      readonly through: number;
    };

/** An op as `BatchTx` collects it, before `checkBatch`. */
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
  if (!NAME_RE.test(name)) {
    throw new ConstraintError(
      `database name must match ${NAME_RE}: got ${JSON.stringify(name)}`,
    );
  }
  return name as DbName;
}

/**
 * A view of a detached buffer reads as empty, so only an empty one needs the
 * look at its buffer, which V8 has to allocate for a small array.
 */
function assertBuffer(bytes: Uint8Array, label: string): void {
  if (bytes.byteLength > 0) return;
  const buf = bytes.buffer as ArrayBuffer & { detached?: boolean };
  if (buf.detached === true) {
    throw new ConstraintError(`${label} buffer is detached`);
  }
}

export function checkKey(bytes: Uint8Array): CheckedKey {
  assertBuffer(bytes, "key");
  if (bytes.byteLength > LIMITS.keyBytes) {
    throw new ConstraintError(`key longer than ${LIMITS.keyBytes} bytes`);
  }
  return new Uint8Array(bytes) as CheckedKey;
}

export function checkValue(bytes: Uint8Array): CheckedValue {
  assertBuffer(bytes, "value");
  return new Uint8Array(bytes) as CheckedValue;
}

/** Key and value bytes of an op: a range delete counts its bounds. */
function opBytes(op: BatchOp): number {
  switch (op.type) {
    case "put":
      return op.key.byteLength + op.value.byteLength;
    case "del":
      return op.key.byteLength;
    case "deleteRange":
      return (op.start?.byteLength ?? 0) + (op.endExclusive?.byteLength ?? 0);
  }
}

/** Key and value bytes of a batch's ops. The batch limit adds `ROW_OVERHEAD` per op to this. */
export function opsBytes(ops: readonly CheckedOp[]): number {
  let bytes = 0;
  for (const op of ops) bytes += opBytes(op);
  return bytes;
}

function checkDeleteRange(op: Extract<BatchOp, { type: "deleteRange" }>): CheckedOp {
  const start = checkKey(op.start ?? new Uint8Array(0));
  const end = op.endExclusive && checkKey(op.endExclusive);
  if (end && compareBytes(start, end) >= 0) {
    throw new ConstraintError("deleteRange needs start below endExclusive");
  }
  if (op.through !== undefined && !(Number.isSafeInteger(op.through) && op.through >= 0)) {
    throw new ConstraintError(`deleteRange through must be a safe integer >= 0: got ${op.through}`);
  }
  return { type: "deleteRange", start, ...(end ? { endExclusive: end } : {}), through: op.through ?? Number.MAX_SAFE_INTEGER };
}

export function checkBatch(ops: readonly BatchOp[]): readonly CheckedOp[] {
  let bytes = 0;
  const out: CheckedOp[] = [];
  for (const op of ops) {
    if (op.type === "put" && op.value === undefined) {
      throw new ConstraintError("put requires a value");
    }
    // Counted before the copies below, so an oversized value is never copied.
    bytes += ROW_OVERHEAD + opBytes(op);
    if (bytes > LIMITS.batchBytes) {
      throw new ConstraintError(
        `batch larger than ${LIMITS.batchBytes} bytes, counting ${ROW_OVERHEAD} bytes per op`,
      );
    }
    switch (op.type) {
      case "put":
        out.push({ type: "put", key: checkKey(op.key), value: checkValue(op.value) });
        break;
      case "del":
        out.push({ type: "del", key: checkKey(op.key) });
        break;
      case "deleteRange":
        out.push(checkDeleteRange(op));
        break;
    }
  }
  return out;
}

export function newWriterId(): WriterId {
  return crypto.randomUUID() as WriterId;
}

import { ConstraintError } from "./errors.js";

const LIMITS = {
  keyBytes: 8 * 1024,
  valueBytes: 16 * 1024 * 1024,
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
  | { readonly type: "del"; readonly key: CheckedKey };

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function checkDbName(name: string): DbName {
  if (!NAME_RE.test(name)) {
    throw new ConstraintError(
      `database name must match ${NAME_RE}: got ${JSON.stringify(name)}`,
    );
  }
  return name as DbName;
}

function assertBuffer(bytes: Uint8Array, label: string): void {
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
  if (bytes.byteLength > LIMITS.valueBytes) {
    throw new ConstraintError(`value longer than ${LIMITS.valueBytes} bytes`);
  }
  return new Uint8Array(bytes) as CheckedValue;
}

/** Key and value bytes of a batch's ops. The batch limit adds `ROW_OVERHEAD` per op to this. */
export function opsBytes(ops: readonly CheckedOp[]): number {
  let bytes = 0;
  for (const op of ops) bytes += op.key.byteLength + (op.type === "put" ? op.value.byteLength : 0);
  return bytes;
}

export function checkBatch(
  ops: readonly { type: "put" | "del"; key: Uint8Array; value?: Uint8Array }[],
): readonly CheckedOp[] {
  let bytes = 0;
  const out: CheckedOp[] = [];
  for (const op of ops) {
    const key = checkKey(op.key);
    bytes += ROW_OVERHEAD + key.byteLength;
    if (op.type === "put") {
      if (op.value === undefined) {
        throw new ConstraintError("put requires a value");
      }
      const value = checkValue(op.value);
      bytes += value.byteLength;
      out.push({ type: "put", key, value });
    } else {
      out.push({ type: "del", key });
    }
    if (bytes > LIMITS.batchBytes) {
      throw new ConstraintError(
        `batch larger than ${LIMITS.batchBytes} bytes, counting ${ROW_OVERHEAD} bytes per op`,
      );
    }
  }
  return out;
}

export function newWriterId(): WriterId {
  return crypto.randomUUID() as WriterId;
}

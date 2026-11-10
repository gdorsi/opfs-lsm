import type { CheckedOp } from "../check.js";
import { CommitError } from "../errors.js";

const OP_PUT = 0;
const OP_DEL = 1;

/**
 * A record body is one batch: per op, a type byte, a u32 key length, the
 * key, and for a put a u32 value length and the value (little-endian). The
 * segment frame around it carries the checksum.
 */
export function encodeOps(ops: readonly CheckedOp[]): Uint8Array {
  let size = 0;
  for (const op of ops) {
    size += 5 + op.key.byteLength + (op.type === "put" ? 4 + op.value.byteLength : 0);
  }
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  for (const op of ops) {
    view.setUint8(at, op.type === "put" ? OP_PUT : OP_DEL);
    view.setUint32(at + 1, op.key.byteLength, true);
    out.set(op.key, at + 5);
    at += 5 + op.key.byteLength;
    if (op.type === "put") {
      view.setUint32(at, op.value.byteLength, true);
      out.set(op.value, at + 4);
      at += 4 + op.value.byteLength;
    }
  }
  return out;
}

/** Keys and values are views into `bytes`. */
export function decodeOps(bytes: Uint8Array): CheckedOp[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ops: CheckedOp[] = [];
  let at = 0;
  const take = (length: number): Uint8Array => {
    if (at + length > bytes.byteLength) throw new CommitError("corrupt record: truncated");
    const out = bytes.subarray(at, at + length);
    at += length;
    return out;
  };
  const u32 = (): number => {
    if (at + 4 > bytes.byteLength) throw new CommitError("corrupt record: truncated");
    const n = view.getUint32(at, true);
    at += 4;
    return n;
  };
  while (at < bytes.byteLength) {
    const type = view.getUint8(at);
    at += 1;
    const key = take(u32()) as CheckedOp["key"];
    if (type === OP_PUT) {
      const value = take(u32()) as Extract<CheckedOp, { type: "put" }>["value"];
      ops.push({ type: "put", key, value });
    } else if (type === OP_DEL) {
      ops.push({ type: "del", key });
    } else {
      throw new CommitError(`corrupt record: op type ${type}`);
    }
  }
  return ops;
}

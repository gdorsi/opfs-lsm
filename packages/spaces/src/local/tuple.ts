/**
 * Order-preserving encoding of index values: docstore's FoundationDB-style
 * tuple layer, byte for byte.
 *
 *   tags   01 null, 02 false, 03 true, 04 number, 05 string
 *   number big-endian float64, sign bit flipped (all bits flipped if negative), -0 as +0
 *   string UTF-8 with 00 written as 00 FF, ending in 00
 *
 * This file is a copy of docstore's `keys.ts` scalar codec. The copy is
 * temporary. "kv gaps" in the rationale proposes moving the codec to
 * `@opfs-lsm/kv/tuple`, where both packages import it.
 *
 * An index key continues a tuple with a 00 separator and the 16-byte record
 * id (`keys.ts` `indexKey`). The id holds random bytes, 0xFF included, where
 * docstore's UTF-8 ids never do, and a 0xFF straight after a string's
 * terminator would read as an escaped 00. The separator keeps what docstore
 * relies on: after a complete field the next byte is a tag (01..05), the
 * separator or a UTF-8 byte, never FF, so `prefix ++ FF` bounds a prefix.
 */

import { concat } from "../bytes.js";
import { SpacesError } from "../errors.js";
import type { Scalar } from "../schema.js";

const TAG = { null: 0x01, false: 0x02, true: 0x03, number: 0x04, string: 0x05 } as const;

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

// One buffer for every key under construction: a key is built synchronously
// from the first write to `take`, so nothing can interleave.
let buf = new Uint8Array(128);
let len = 0;
const f64 = new DataView(new ArrayBuffer(8));

function room(n: number): void {
  if (len + n <= buf.length) return;
  const next = new Uint8Array(Math.max(buf.length * 2, len + n));
  next.set(buf.subarray(0, len));
  buf = next;
}

/** Encodes straight into `buf` (a UTF-16 unit is at most 3 UTF-8 bytes), then opens room for the escapes, which are rare. */
function writeEscaped(s: string): void {
  room(s.length * 3);
  const start = len;
  len += utf8.encodeInto(s, buf.subarray(len)).written;
  let zeros = 0;
  for (let i = start; i < len; i++) if (buf[i] === 0) zeros++;
  if (zeros === 0) return;
  room(zeros);
  let w = len + zeros;
  for (let r = len - 1; r >= start; r--) {
    const b = buf[r]!;
    if (b === 0) buf[--w] = 0xff;
    buf[--w] = b;
  }
  len += zeros;
}

function writeScalar(v: Scalar): void {
  room(9);
  if (v === null) buf[len++] = TAG.null;
  else if (v === false) buf[len++] = TAG.false;
  else if (v === true) buf[len++] = TAG.true;
  else if (typeof v === "number") {
    buf[len++] = TAG.number;
    f64.setFloat64(0, v === 0 ? 0 : v);
    const negative = f64.getUint8(0) >= 0x80;
    for (let i = 0; i < 8; i++) {
      const b = f64.getUint8(i);
      buf[len++] = negative ? ~b & 0xff : i === 0 ? b ^ 0x80 : b;
    }
  } else {
    buf[len++] = TAG.string;
    writeEscaped(v);
    room(1);
    buf[len++] = 0x00;
  }
}

const take = (): Uint8Array => buf.slice(0, len);

export function encodeTuple(values: readonly Scalar[]): Uint8Array {
  len = 0;
  for (const v of values) writeScalar(v);
  return take();
}

/** The encoding of `values` as a key prefix, for `eq` and `startsWith` ranges. */
export function encodeTuplePrefix(values: readonly Scalar[], startsWith?: string): Uint8Array {
  len = 0;
  for (const v of values) writeScalar(v);
  if (startsWith !== undefined) {
    room(1);
    buf[len++] = TAG.string;
    writeEscaped(startsWith);
  }
  return take();
}

export function decodeTuple(bytes: Uint8Array): Scalar[] {
  const out: Scalar[] = [];
  let at = 0;
  while (at < bytes.length) {
    switch (bytes[at++]) {
      case TAG.null:
        out.push(null);
        break;
      case TAG.false:
        out.push(false);
        break;
      case TAG.true:
        out.push(true);
        break;
      case TAG.number: {
        if (at + 8 > bytes.length) throw new SpacesError("protocol", "truncated number in a tuple");
        const negative = bytes[at]! < 0x80;
        for (let i = 0; i < 8; i++) {
          const b = bytes[at + i]!;
          f64.setUint8(i, negative ? ~b & 0xff : i === 0 ? b ^ 0x80 : b);
        }
        out.push(f64.getFloat64(0));
        at += 8;
        break;
      }
      case TAG.string: {
        const chunks: Uint8Array[] = [];
        let from = at;
        for (;;) {
          if (at >= bytes.length) throw new SpacesError("protocol", "unterminated string in a tuple");
          if (bytes[at] !== 0) {
            at++;
            continue;
          }
          chunks.push(bytes.subarray(from, at));
          if (bytes[at + 1] === 0xff) {
            chunks.push(Uint8Array.of(0));
            at += 2;
            from = at;
          } else {
            at++;
            break;
          }
        }
        out.push(fromUtf8.decode(chunks.length === 1 ? chunks[0]! : concat(...chunks)));
        break;
      }
      default:
        throw new SpacesError("protocol", "unknown tag in a tuple");
    }
  }
  return out;
}

function checkValue(value: unknown): Scalar {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string" && value.isWellFormed()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value === 0 ? 0 : value;
  throw new SpacesError(
    "validation",
    `${String(value)} is not an index value: use null, a boolean, a finite number or a well-formed string`,
  );
}

export type TupleWhere = {
  readonly eq?: readonly Scalar[] | undefined;
  readonly gt?: Scalar | undefined;
  readonly gte?: Scalar | undefined;
  readonly lt?: Scalar | undefined;
  readonly lte?: Scalar | undefined;
  readonly startsWith?: string | undefined;
};

/**
 * Lowers docstore's `Where` to one key range under `prefix`: `eq` fixes the
 * first k components, and one bound applies to component k + 1. `arity` is
 * the number of components the index has.
 */
export function tupleRange(
  prefix: Uint8Array,
  arity: number,
  where: TupleWhere,
): { readonly start: Uint8Array; readonly endExclusive: Uint8Array } {
  const { gt, gte, lt, lte, startsWith } = where;
  if (gt !== undefined && gte !== undefined) throw new SpacesError("validation", "gt and gte together");
  if (lt !== undefined && lte !== undefined) throw new SpacesError("validation", "lt and lte together");
  const bounded = gt !== undefined || gte !== undefined || lt !== undefined || lte !== undefined;
  if (startsWith !== undefined && (bounded || typeof startsWith !== "string" || !startsWith.isWellFormed())) {
    throw new SpacesError("validation", "startsWith takes a well-formed string and no other bound");
  }
  const eq = where.eq ?? [];
  if (!Array.isArray(eq) || eq.length > arity) throw new SpacesError("validation", `eq takes at most ${arity} values`);
  if (eq.length === arity && (bounded || startsWith !== undefined)) {
    throw new SpacesError("validation", "eq fixes every component, so no bound can follow");
  }
  const base = concat(prefix, encodeTuple(eq.map(checkValue)));
  const at = (v: unknown) => concat(base, encodeTuple([checkValue(v)]));
  if (startsWith !== undefined) {
    const start = concat(base, encodeTuplePrefix([], startsWith));
    return { start, endExclusive: upperOf(start) };
  }
  const start = gte !== undefined ? at(gte) : gt !== undefined ? upperOf(at(gt)) : base;
  const end = lte !== undefined ? upperOf(at(lte)) : lt !== undefined ? at(lt) : upperOf(base);
  return { start, endExclusive: end };
}

/** `prefix ++ FF`: above every key that continues `prefix` at a field boundary. */
const upperOf = (prefix: Uint8Array): Uint8Array => concat(prefix, Uint8Array.of(0xff));

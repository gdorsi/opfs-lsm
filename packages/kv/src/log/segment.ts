import type { LogId, PredEdge, RecordN } from "../host/queues.js";
import { crc32 } from "../store/crc32.js";

/**
 * A log segment, `w/<log>/<firstN:10>.seg`. A 32-byte header, written and
 * flushed before any frame:
 *
 *   u8[4] "OLQS" | u32 version | u32 nonce | u32 firstN |
 *   u8[8] pred log (zero: no pred) | u32 pred lastN | u32 crc32(bytes 0..28)
 *
 * then frames, little-endian:
 *
 *   u32 bodyLen | u32 crc(nonce, kind, n, body) | u8 kind | u32 n | body
 *
 * Record frames are numbered firstN, firstN + 1, ... A SEAL frame carries
 * the next record's n and ends the segment before its successor exists.
 * Seeding the CRC with the segment's random nonce means frame-shaped bytes
 * inside a value pass as a frame of this segment only if they copy this
 * segment's own bytes.
 */
export type SegmentHeader = { readonly nonce: number; readonly firstN: RecordN; readonly pred?: PredEdge };

export type Frame = {
  readonly kind: "record" | "seal";
  readonly n: RecordN;
  readonly body: Uint8Array;
  /** Offset of the byte after the frame. */
  readonly end: number;
};

export const HEADER_BYTES = 32;
export const FRAME_HEAD_BYTES = 13;
const MAGIC = [0x4f, 0x4c, 0x51, 0x53];
const VERSION = 1;
const RECORD = 1;
const SEAL = 2;
const LOG_ID = /^(?!0{16})[0-9a-f]{16}$/;
const SEGMENT_NAME = /^(\d{10})\.seg$/;

export function segmentPath(log: LogId, firstN: RecordN): string {
  return `w/${log}/${String(firstN).padStart(10, "0")}.seg`;
}

/** The firstN of a file listed in `w/<log>/`, or undefined for a file that is not a segment. */
export function parseSegmentName(name: string): RecordN | undefined {
  const m = SEGMENT_NAME.exec(name);
  const n = m ? Number(m[1]) : 0;
  return n >= 1 && n <= 0xffff_ffff ? n : undefined;
}

const u32 = (b: Uint8Array, at: number): number => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;

export function encodeHeader(h: SegmentHeader): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES);
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  view.setUint32(4, VERSION, true);
  view.setUint32(8, h.nonce, true);
  view.setUint32(12, h.firstN, true);
  if (h.pred) {
    if (!LOG_ID.test(h.pred.log)) throw new RangeError(`pred log must be 16 hex digits, not all zero: ${h.pred.log}`);
    for (let i = 0; i < 8; i++) out[16 + i] = parseInt(h.pred.log.slice(2 * i, 2 * i + 2), 16);
    view.setUint32(24, h.pred.lastN, true);
  }
  view.setUint32(28, crc32(out.subarray(0, 28)), true);
  return out;
}

/** The header of the segment listed as `firstN`, or undefined when it is short, torn or another segment's. */
export function decodeHeader(bytes: Uint8Array, firstN: RecordN): SegmentHeader | undefined {
  if (bytes.byteLength < HEADER_BYTES || MAGIC.some((b, i) => bytes[i] !== b)) return undefined;
  if (u32(bytes, 4) !== VERSION || u32(bytes, 12) !== firstN || u32(bytes, 28) !== crc32(bytes.subarray(0, 28))) return undefined;
  const nonce = u32(bytes, 8);
  const predLog = bytes.subarray(16, 24);
  if (predLog.every((b) => b === 0)) return { nonce, firstN };
  const log = Array.from(predLog, (b) => b.toString(16).padStart(2, "0")).join("") as LogId;
  return { nonce, firstN, pred: { log, lastN: u32(bytes, 24) } };
}

export function frameSeed(nonce: number): number {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, nonce, true);
  return crc32(b);
}

function putFrame(out: Uint8Array, view: DataView, at: number, kind: number, n: RecordN, body: Uint8Array, seed: number): number {
  const end = at + FRAME_HEAD_BYTES + body.byteLength;
  view.setUint32(at, body.byteLength, true);
  view.setUint8(at + 8, kind);
  view.setUint32(at + 9, n, true);
  out.set(body, at + FRAME_HEAD_BYTES);
  view.setUint32(at + 4, crc32(out.subarray(at + 8, end), seed), true);
  return end;
}

/** One write's bytes: a record frame per body, numbered from `n`. */
export function encodeRecords(bodies: readonly Uint8Array[], n: RecordN, seed: number): Uint8Array {
  let size = 0;
  for (const body of bodies) size += FRAME_HEAD_BYTES + body.byteLength;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  for (let i = 0; i < bodies.length; i++) at = putFrame(out, view, at, RECORD, n + i, bodies[i]!, seed);
  return out;
}

/** The SEAL frame of a segment whose next record would be `n`. */
export function encodeSeal(n: RecordN, seed: number): Uint8Array {
  const out = new Uint8Array(FRAME_HEAD_BYTES);
  putFrame(out, new DataView(out.buffer), 0, SEAL, n, new Uint8Array(0), seed);
  return out;
}

/** The frame at `at` when all of its bytes are there and its kind is known. Its CRC is not checked: see `frameSigned`. */
export function frameAt(bytes: Uint8Array, at: number): Frame | undefined {
  if (at + FRAME_HEAD_BYTES > bytes.byteLength) return undefined;
  const end = at + FRAME_HEAD_BYTES + u32(bytes, at);
  const kind = bytes[at + 8] === RECORD ? "record" : bytes[at + 8] === SEAL && end === at + FRAME_HEAD_BYTES ? "seal" : undefined;
  if (kind === undefined || end > bytes.byteLength) return undefined;
  return { kind, n: u32(bytes, at + 9), body: bytes.subarray(at + FRAME_HEAD_BYTES, end), end };
}

/** Whether the frame at `at` was written with this seed, so by this segment's writer. */
export function frameSigned(bytes: Uint8Array, at: number, frame: Frame, seed: number): boolean {
  return crc32(bytes.subarray(at + 8, frame.end), seed) === u32(bytes, at + 4);
}

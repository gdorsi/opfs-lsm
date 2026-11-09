import type { CheckedOp } from "../check.js";
import { CommitError } from "../errors.js";
import { crc32 } from "../store/crc32.js";

/**
 * Each tab writes its own log under `w/<tab>/`, a chain of segment files.
 * A segment is a run of frames:
 *
 *   u32 bodyLen | u32 crc(kind, stamp, n, body) | u8 kind | u64 stamp | u32 n | body
 *
 * A RECORD frame holds one batch (`encodeOps`). `stamp` is the HLC stamp
 * that orders it among every tab's records, and `n` counts the tab's
 * records from 1 with no gaps. A SEAL frame ends a segment; the chain goes
 * on in the next segment by name.
 *
 * A frame is part of the log when it is whole, its CRC holds, its `n` is
 * the previous one + 1 and its stamp is above the previous one. Readers
 * stop at the first frame that breaks this, so a torn tail is invisible and
 * every read of a tab's log is a prefix of it.
 */
const FRAME_HEAD = 21;
export const KIND_RECORD = 1;
export const KIND_SEAL = 2;

/** An HLC stamp: wall-clock microseconds since 2025 × 4 + a counter, so it fits a safe integer. */
export type Stamp = number;
/** A tab's id: 16 hex digits, also its directory under `w/`. */
export type TabId = string;

export const LOG_DIR = "w";

export function newTabId(): TabId {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function isTabId(name: string): boolean {
  return /^[0-9a-f]{16}$/.test(name);
}

export function tabDir(tab: TabId): string {
  return `${LOG_DIR}/${tab}`;
}

/**
 * A segment's name: the `n` of its first record, and the stamp of the last
 * record before it (0 for the tab's first segment). Every record in a
 * segment is above `prevStamp`, and below the next segment's.
 */
export type SegmentName = { readonly firstN: number; readonly prevStamp: Stamp };

export function segmentFile(name: SegmentName): string {
  return `${String(name.firstN).padStart(10, "0")}.${String(name.prevStamp).padStart(16, "0")}.wal`;
}

export function segmentPath(tab: TabId, name: SegmentName): string {
  return `${tabDir(tab)}/${segmentFile(name)}`;
}

/** The segment a file name in a tab's directory names, or undefined for anything else. */
export function parseSegment(file: string): SegmentName | undefined {
  const m = /^(\d{10})\.(\d{16})\.wal$/.exec(file);
  return m ? { firstN: Number(m[1]), prevStamp: Number(m[2]) } : undefined;
}

export function encodeFrame(kind: number, stamp: Stamp, n: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(FRAME_HEAD + body.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.byteLength, true);
  view.setUint8(8, kind);
  view.setBigUint64(9, BigInt(stamp), true);
  view.setUint32(17, n, true);
  out.set(body, FRAME_HEAD);
  view.setUint32(4, crc32(out.subarray(8)), true);
  return out;
}

/** One record read back from a log. `ops` are views into the bytes read. */
export type LogRecord = {
  readonly stamp: Stamp;
  readonly n: number;
  readonly ops: readonly CheckedOp[];
};

export type ScanResult = {
  readonly records: LogRecord[];
  /** Bytes of the input that held valid frames, SEAL included. */
  readonly validBytes: number;
  readonly sealed: boolean;
  /** The last valid record's `n` and stamp (skipped or not), or the ones passed in. */
  readonly n: number;
  readonly stamp: Stamp;
};

/**
 * Scan frames after a record with `n` and `stamp` (0 and 0 at the start of
 * a tab's log; `n` undefined accepts any first `n`, after reclaimed
 * segments). Stops at the end, at a frame that breaks the rule, or after a
 * SEAL. Records at or below `skipThrough` are not decoded or returned (a
 * generation already holds them), and only their `n` and stamp are
 * checked. Pure.
 */
export function scanFrames(
  bytes: Uint8Array,
  n: number | undefined,
  stamp: Stamp,
  skipThrough: Stamp = 0,
): ScanResult {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const records: LogRecord[] = [];
  let at = 0;
  let lastN = n;
  let lastStamp = stamp;
  while (at + FRAME_HEAD <= bytes.byteLength) {
    const len = view.getUint32(at, true);
    const end = at + FRAME_HEAD + len;
    if (end > bytes.byteLength) break;
    const kind = view.getUint8(at + 8);
    const frameStamp = Number(view.getBigUint64(at + 9, true));
    const frameN = view.getUint32(at + 17, true);
    // A record under the cut was checked by the ingest that folded it, and
    // one still being written is above it: only its place in the chain is
    // checked here, not its CRC.
    const folded = kind === KIND_RECORD && frameStamp <= skipThrough;
    if (!folded && crc32(bytes.subarray(at + 8, end)) !== view.getUint32(at + 4, true)) break;
    if (kind === KIND_SEAL) {
      if (lastN !== undefined && frameN !== lastN) break;
      return { records, validBytes: end, sealed: true, n: frameN, stamp: lastStamp };
    }
    if (kind !== KIND_RECORD) break;
    // A stamp past 2^53 no stamp ever reaches would round: not a frame this code wrote.
    if (!Number.isSafeInteger(frameStamp)) break;
    if (lastN !== undefined && frameN !== lastN + 1) break;
    if (frameStamp <= lastStamp) break;
    if (!folded) {
      records.push({ stamp: frameStamp, n: frameN, ops: decodeOps(bytes.subarray(at + FRAME_HEAD, end)) });
    }
    lastN = frameN;
    lastStamp = frameStamp;
    at = end;
  }
  return { records, validBytes: at, sealed: false, n: lastN ?? 0, stamp: lastStamp };
}

const OP_PUT = 0;
const OP_DEL = 1;

/** Per op: a type byte, a u32 key length, the key, and for a put a u32 value length and the value (LE). */
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
    if (at + length > bytes.byteLength) throw new CommitError("corrupt log record: truncated");
    const out = bytes.subarray(at, at + length);
    at += length;
    return out;
  };
  const u32 = (): number => {
    if (at + 4 > bytes.byteLength) throw new CommitError("corrupt log record: truncated");
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
      throw new CommitError(`corrupt log op ${type}`);
    }
  }
  return ops;
}

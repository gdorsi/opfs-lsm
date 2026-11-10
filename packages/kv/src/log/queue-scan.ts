import type { CheckedOp } from "../check.js";
import type { LogId, QueueScan, RecordN } from "../host/queues.js";
import { decodeOps } from "../idb/wal.js";
import { decodeHeader, frameAt, frameSeed, frameSigned, HEADER_BYTES } from "./segment.js";

/**
 * One segment file a listing of `w/<log>/` found, and what reading it gave:
 * its bytes, which may be a stale or short prefix (Safari's snapshot,
 * Firefox's live read), or "unreadable" (Chrome's NotReadableError).
 */
export type ListedSegment = { readonly firstN: RecordN; readonly bytes: Uint8Array | "unreadable" };

type Stop =
  | { readonly at: "fence" }
  | { readonly at: "header" }
  | { readonly at: "eof" }
  | { readonly at: "seal" }
  | { readonly at: "break"; readonly offset: number; readonly n: RecordN; readonly seed: number }
  | { readonly at: "body" };

const HOLE_REASON = { header: "bad segment header", eof: "segment ends short", seal: "segment ends short", break: "bad frame", body: "record does not decode" } as const;

/**
 * One log read from cursor `from`, over the segments a listing found. Each
 * segment ends at its SEAL or at record `next.firstN - 1`, whichever comes
 * first, and bytes past that are never read. On a live log a break in the
 * last segment is the end for now. Damage is judged only on a segment with
 * a successor (it must reach the successor's firstN - 1), and on a dead
 * log's last segment (a whole frame of its nonce numbered past a bad one, or
 * a SEAL with no successor). Pure and total: any bytes give a scan.
 */
export function scanLog(log: LogId, from: RecordN, dead: boolean, listed: readonly ListedSegment[]): QueueScan {
  const segs = [...listed].sort((a, b) => a.firstN - b.firstN);
  const first = segs[0];
  const pred = first?.firstN === 1 && first.bytes !== "unreadable" ? decodeHeader(first.bytes, 1)?.pred : undefined;
  const records: QueueScan["records"][number][] = [];
  const out = (stop: QueueScan["stop"]): QueueScan => (pred ? { log, dead, pred, records, stop } : { log, dead, records, stop });

  let want = from + 1;
  let i = -1;
  for (let k = 0; k < segs.length; k++) if (segs[k]!.firstN <= want) i = k;
  if (segs.length === 0) return out("end");
  if (i < 0) return out({ hole: want, reason: "segment missing" });
  for (; ; i++) {
    const seg = segs[i]!;
    const next = segs[i + 1];
    if (seg.firstN > want) return out({ hole: want, reason: "segment missing" });
    if (seg.bytes === "unreadable") return out("partial");
    const stop = readSegment(seg.bytes, seg.firstN, from, next ? next.firstN - 1 : Infinity, records);
    want = records.length > 0 ? records[records.length - 1]!.n + 1 : from + 1;
    if (next) {
      if (stop.at !== "fence") return out({ hole: want, reason: HOLE_REASON[stop.at] });
      continue;
    }
    switch (stop.at) {
      case "header":
      case "eof":
      case "fence":
        return out("end");
      case "seal":
        return out(dead ? { hole: want, reason: "sealed segment has no successor" } : "partial");
      case "break":
        return out(dead && signedAfter(seg.bytes, stop.offset, stop.seed, Math.max(stop.n + 1, want)) ? { hole: want, reason: "bad frame" } : "end");
      case "body":
        return out({ hole: want, reason: HOLE_REASON.body });
    }
  }
}

/** Frames at or below `from` were read by an earlier scan, so they are walked by length and not checked. */
function readSegment(bytes: Uint8Array, firstN: RecordN, from: RecordN, fence: RecordN, records: QueueScan["records"][number][]): Stop {
  const header = decodeHeader(bytes, firstN);
  if (!header) return { at: "header" };
  const seed = frameSeed(header.nonce);
  let at = HEADER_BYTES;
  for (let n = firstN; n <= fence; n++) {
    if (at === bytes.byteLength) return { at: "eof" };
    const f = frameAt(bytes, at);
    if (!f || f.n !== n || ((n > from || f.kind === "seal") && !frameSigned(bytes, at, f, seed))) return { at: "break", offset: at, n, seed };
    if (f.kind === "seal") return { at: "seal" };
    if (n > from) {
      const ops = decode(f.body);
      if (!ops) return { at: "body" };
      records.push({ n, ops, bytes: f.body.byteLength });
    }
    at = f.end;
  }
  return { at: "fence" };
}

/**
 * A whole frame of this segment numbered `min` or more, at or after
 * `offset`, makes a break damage rather than a torn tail. A value that
 * copies one of this segment's frames copies an earlier n, so it never
 * passes.
 */
function signedAfter(bytes: Uint8Array, offset: number, seed: number, min: RecordN): boolean {
  for (let at = offset; at < bytes.byteLength; at++) {
    const f = frameAt(bytes, at);
    if (f && f.n >= min && frameSigned(bytes, at, f, seed)) return true;
  }
  return false;
}

function decode(body: Uint8Array): CheckedOp[] | undefined {
  try {
    return decodeOps(body.slice().buffer);
  } catch {
    return undefined;
  }
}

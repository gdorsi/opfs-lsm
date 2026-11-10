import { describe, expect, it } from "vitest";
import type { CheckedKey, CheckedOp, CheckedValue } from "../src/check.js";
import type { LogId, PredEdge, QueueScan } from "../src/host/queues.js";
import { encodeOps } from "../src/idb/wal.js";
import { scanLog, type ListedSegment } from "../src/log/queue-scan.js";
import { encodeHeader, encodeRecords, encodeSeal, frameSeed } from "../src/log/segment.js";

const LOG = "00000000000000b2" as LogId;
const PRED: PredEdge = { log: "00000000000000a1" as LogId, lastN: 4 };

const opsOf = (n: number): CheckedOp[] => [{ type: "put", key: Uint8Array.of(n) as CheckedKey, value: Uint8Array.of(n, n) as CheckedValue }];
const bodyOf = (n: number): Uint8Array => new Uint8Array(encodeOps(opsOf(n)));
const range = (lo: number, hi: number): number[] => Array.from({ length: Math.max(0, hi - lo + 1) }, (_, i) => lo + i);
const ns = (scan: QueueScan): number[] => scan.records.map((r) => r.n);

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function segment(firstN: number, count: number, opts: { pred?: PredEdge; sealed?: boolean; bodies?: Uint8Array[] } = {}): Uint8Array {
  const nonce = firstN * 7919;
  const seed = frameSeed(nonce);
  const bodies = opts.bodies ?? range(firstN, firstN + count - 1).map(bodyOf);
  const parts = [encodeHeader(opts.pred ? { nonce, firstN, pred: opts.pred } : { nonce, firstN }), encodeRecords(bodies, firstN, seed)];
  if (opts.sealed) parts.push(encodeSeal(firstN + bodies.length, seed));
  return concat(parts);
}

const LISTING: ListedSegment[] = [
  { firstN: 1, bytes: segment(1, 3, { pred: PRED, sealed: true }) },
  { firstN: 4, bytes: segment(4, 2, { sealed: true }) },
  { firstN: 6, bytes: segment(6, 2) },
];

describe("scanLog", () => {
  it("reads every record past the cursor across sealed segments, with their ops", () => {
    for (const dead of [false, true]) {
      for (let from = 0; from <= 7; from++) {
        const scan = scanLog(LOG, from, dead, LISTING);
        expect(scan.records.map((r) => [r.n, r.ops])).toEqual(range(from + 1, 7).map((n) => [n, opsOf(n)]));
        expect(scan).toMatchObject({ log: LOG, dead, pred: PRED, stop: "end" });
      }
    }
  });

  it("takes the listing in any order, and has no pred once segment 1 is reclaimed", () => {
    expect(scanLog(LOG, 0, false, [...LISTING].reverse())).toEqual(scanLog(LOG, 0, false, LISTING));
    const reclaimed = scanLog(LOG, 3, false, LISTING.slice(1));
    expect([ns(reclaimed), reclaimed.stop, reclaimed.pred]).toEqual([[4, 5, 6, 7], "end", undefined]);
  });

  it("reads a live log's sealed last segment as partial and a dead log's as a hole", () => {
    const listed = LISTING.slice(0, 2);
    expect([ns(scanLog(LOG, 0, false, listed)), scanLog(LOG, 0, false, listed).stop]).toEqual([[1, 2, 3, 4, 5], "partial"]);
    expect(scanLog(LOG, 0, true, listed).stop).toEqual({ hole: 6, reason: "sealed segment has no successor" });
  });

  it("stops at an unreadable segment for now, and skips one below the cursor", () => {
    const unreadable = (i: number): ListedSegment[] => LISTING.map((s, k) => (k === i ? { firstN: s.firstN, bytes: "unreadable" } : s));
    for (const dead of [false, true]) {
      expect([ns(scanLog(LOG, 0, dead, unreadable(1))), scanLog(LOG, 0, dead, unreadable(1)).stop]).toEqual([[1, 2, 3], "partial"]);
      expect([ns(scanLog(LOG, 0, dead, unreadable(2))), scanLog(LOG, 0, dead, unreadable(2)).stop]).toEqual([[1, 2, 3, 4, 5], "partial"]);
      expect([ns(scanLog(LOG, 3, dead, unreadable(0))), scanLog(LOG, 3, dead, unreadable(0)).stop]).toEqual([[4, 5, 6, 7], "end"]);
    }
  });

  it("reports a missing segment as a hole", () => {
    for (const dead of [false, true]) {
      const middle = scanLog(LOG, 0, dead, [LISTING[0]!, LISTING[2]!]);
      expect([ns(middle), middle.stop]).toEqual([[1, 2, 3], { hole: 4, reason: "segment ends short" }]);
      const first = scanLog(LOG, 0, dead, LISTING.slice(1));
      expect([ns(first), first.stop]).toEqual([[], { hole: 1, reason: "segment missing" }]);
    }
  });

  it("reports a flipped byte in a finished segment as a hole at its record, and never reads past the fence", () => {
    const bytes = LISTING[0]!.bytes as Uint8Array;
    const frameEnds = [32, ...range(1, 3).map((n) => 32 + n * (13 + bodyOf(n).length))];
    let flips = 0;
    for (let i = 0; i < bytes.length; i++) {
      const flipped = bytes.slice();
      flipped[i]! ^= 0x40;
      const n = frameEnds.findIndex((end) => i < end);
      for (const dead of [false, true]) {
        const scan = scanLog(LOG, 0, dead, [{ firstN: 1, bytes: flipped }, ...LISTING.slice(1)]);
        if (n === -1) expect([ns(scan), scan.stop]).toEqual([range(1, 7), "end"]);
        else expect([ns(scan), scan.stop]).toMatchObject([range(1, n - 1), { hole: Math.max(n, 1) }]);
        flips++;
      }
    }
    expect(flips).toBe(2 * bytes.length);
  });

  it("calls a whole frame after a bad one in a dead log's last segment a hole, and a live log's the end for now", () => {
    const last = segment(6, 4);
    const second = 32 + 13 + bodyOf(6).length;
    const bad = last.slice();
    bad[second + 13]! ^= 0x40;
    const listed = [...LISTING.slice(0, 2), { firstN: 6, bytes: bad }];
    expect([ns(scanLog(LOG, 0, false, listed)), scanLog(LOG, 0, false, listed).stop]).toEqual([range(1, 6), "end"]);
    expect([ns(scanLog(LOG, 0, true, listed)), scanLog(LOG, 0, true, listed).stop]).toEqual([range(1, 6), { hole: 7, reason: "bad frame" }]);

    const lastFrameBad = last.slice();
    lastFrameBad[last.length - 1]! ^= 0x40;
    const tail = scanLog(LOG, 0, true, [...LISTING.slice(0, 2), { firstN: 6, bytes: lastFrameBad }]);
    expect([ns(tail), tail.stop]).toEqual([range(1, 8), "end"]);
  });

  it("reports a whole frame whose body does not decode as a hole", () => {
    const listed = [...LISTING.slice(0, 2), { firstN: 6, bytes: segment(6, 0, { bodies: [bodyOf(6), Uint8Array.of(9)] }) }];
    for (const dead of [false, true]) {
      const scan = scanLog(LOG, 0, dead, listed);
      expect([ns(scan), scan.stop]).toEqual([range(1, 6), { hole: 7, reason: "record does not decode" }]);
    }
  });

  it("reads an empty log, or a segment whose header is not written yet, as the end", () => {
    for (const dead of [false, true]) {
      expect(scanLog(LOG, 0, dead, [])).toEqual({ log: LOG, dead, records: [], stop: "end" });
      expect(scanLog(LOG, 0, dead, [{ firstN: 1, bytes: new Uint8Array(20) }])).toEqual({ log: LOG, dead, records: [], stop: "end" });
    }
  });
});

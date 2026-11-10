import { describe, expect, it } from "vitest";
import type { LogId } from "../src/host/queues.js";
import {
  decodeHeader,
  encodeHeader,
  encodeRecords,
  encodeSeal,
  frameAt,
  frameSeed,
  frameSigned,
  parseSegmentName,
  segmentPath,
} from "../src/log/segment.js";

const PRED = "00000000000000a1" as LogId;

describe("segment header", () => {
  it("round-trips nonce, firstN and pred", () => {
    expect(decodeHeader(encodeHeader({ nonce: 7, firstN: 1, pred: { log: PRED, lastN: 9 } }), 1)).toEqual({
      nonce: 7,
      firstN: 1,
      pred: { log: PRED, lastN: 9 },
    });
    expect(decodeHeader(encodeHeader({ nonce: 0xffff_ffff, firstN: 40 }), 40)).toEqual({ nonce: 0xffff_ffff, firstN: 40 });
  });

  it("rejects a header that is torn, flipped or named for another firstN", () => {
    const h = encodeHeader({ nonce: 7, firstN: 3, pred: { log: PRED, lastN: 2 } });
    expect(decodeHeader(h, 4)).toBeUndefined();
    for (let cut = 0; cut < h.length; cut++) expect(decodeHeader(h.subarray(0, cut), 3)).toBeUndefined();
    for (let i = 0; i < h.length; i++) {
      const flipped = h.slice();
      flipped[i]! ^= 0x01;
      expect(decodeHeader(flipped, 3)).toBeUndefined();
    }
  });

  it("refuses a pred log it cannot store", () => {
    expect(() => encodeHeader({ nonce: 1, firstN: 1, pred: { log: "p" as LogId, lastN: 1 } })).toThrow(RangeError);
    expect(() => encodeHeader({ nonce: 1, firstN: 1, pred: { log: "0000000000000000" as LogId, lastN: 1 } })).toThrow(RangeError);
  });
});

describe("segment frames", () => {
  it("reads back records and a SEAL, signed only by their own nonce", () => {
    const seed = frameSeed(11);
    const bytes = new Uint8Array([...encodeRecords([Uint8Array.of(1, 2), new Uint8Array(0)], 5, seed), ...encodeSeal(7, seed)]);
    const a = frameAt(bytes, 0)!;
    const b = frameAt(bytes, a.end)!;
    const seal = frameAt(bytes, b.end)!;
    expect([a.kind, a.n, [...a.body]]).toEqual(["record", 5, [1, 2]]);
    expect([b.kind, b.n, b.body.length]).toEqual(["record", 6, 0]);
    expect([seal.kind, seal.n, seal.end]).toEqual(["seal", 7, bytes.length]);
    for (const [at, f] of [[0, a], [a.end, b], [b.end, seal]] as const) {
      expect(frameSigned(bytes, at, f, seed)).toBe(true);
      expect(frameSigned(bytes, at, f, frameSeed(12))).toBe(false);
    }
  });

  it("does not read a frame whose bytes are not all there", () => {
    const bytes = encodeRecords([Uint8Array.of(1, 2, 3)], 1, frameSeed(1));
    for (let cut = 0; cut < bytes.length; cut++) expect(frameAt(bytes.subarray(0, cut), 0)).toBeUndefined();
  });
});

describe("segment names", () => {
  it("names a segment by its firstN so names sort by it, and parses only such names", () => {
    expect(segmentPath(PRED, 42)).toBe("w/00000000000000a1/0000000042.seg");
    expect(parseSegmentName("0000000042.seg")).toBe(42);
    expect(parseSegmentName("4294967295.seg")).toBe(4294967295);
    for (const name of ["0000000000.seg", "4294967296.seg", "42.seg", "0000000042.seg.crswap", "0000000042.tmp"]) {
      expect(parseSegmentName(name)).toBeUndefined();
    }
  });
});

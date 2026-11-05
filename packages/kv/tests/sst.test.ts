import { describe, expect, it } from "vitest";
import { CorruptDatabaseError } from "../src/errors.js";
import {
  decodeSst,
  encodeSst,
  SstReader,
  SST_BLOCK_TARGET,
} from "../src/store/sst.js";
import { pointGet } from "../src/store/merge.js";

const enc = new TextEncoder();
const utf = (s: string) => enc.encode(s);

/** Two entries (put a=1, del b) written by the v2 encoder, before records carried a seq. */
const V2_FIXTURE =
  "54534c4f02000000020000000100000015000000070008008d008209207040000200000001010000006101000000310201000000620100000061010000006200000000150000001e2bc0b9";

describe("sst", () => {
  it("round-trips each entry's seq", () => {
    const body = encodeSst([
      { kind: "put", key: utf("a"), value: utf("1"), seq: 7 },
      { kind: "del", key: utf("b"), seq: 2 ** 40 },
    ]);
    expect(decodeSst(body).map((e) => e.seq)).toEqual([7, 2 ** 40]);
    expect(new SstReader(body).get(utf("b"))).toEqual({ kind: "del", key: utf("b"), seq: 2 ** 40 });
  });

  it("reads a v2 run, with seq 0", () => {
    const body = Uint8Array.from(V2_FIXTURE.match(/../g)!.map((h) => parseInt(h, 16)));
    expect(decodeSst(body)).toEqual([
      { kind: "put", key: utf("a"), value: utf("1"), seq: 0 },
      { kind: "del", key: utf("b"), seq: 0 },
    ]);
    expect(new SstReader(body).get(utf("a"))?.seq).toBe(0);
  });

  it("round-trips puts and deletes", () => {
    const body = encodeSst([
      { kind: "put", key: utf("b"), value: utf("2") },
      { kind: "del", key: utf("a") },
      { kind: "put", key: utf("c"), value: utf("3") },
    ]);
    const entries = decodeSst(body);
    expect(entries.map((e) => e.kind + ":" + new TextDecoder().decode(e.key))).toEqual([
      "del:a",
      "put:b",
      "put:c",
    ]);
  });

  it("rejects corrupt crc", () => {
    const body = encodeSst([{ kind: "put", key: utf("a"), value: utf("1") }]);
    body[body.byteLength - 1] ^= 0xff;
    expect(() => decodeSst(body)).toThrow(CorruptDatabaseError);
  });

  it("splits into multiple blocks", () => {
    const entries = Array.from({ length: 200 }, (_, i) => ({
      kind: "put" as const,
      key: utf(`k${String(i).padStart(4, "0")}`),
      value: utf(`v${i}`),
    }));
    const body = encodeSst(entries, 256);
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    expect(view.getUint32(4, true)).toBe(3); // version
    expect(view.getUint32(12, true)).toBeGreaterThan(1); // blockCount
    expect(decodeSst(body)).toHaveLength(200);
  });

  it("SstReader point-gets via bloom + one block", () => {
    const entries = Array.from({ length: 80 }, (_, i) => ({
      kind: "put" as const,
      key: utf(`k${String(i).padStart(3, "0")}`),
      value: utf(`v${i}`),
    }));
    const body = encodeSst(entries, 200);
    const reader = new SstReader(body);
    expect(reader.mightContain(utf("k040"))).toBe(true);
    expect(reader.get(utf("k040"))).toEqual({
      kind: "put",
      key: utf("k040"),
      value: utf("v40"),
      seq: 0,
    });
    expect(reader.get(utf("missing"))).toBeUndefined();
  });

  it("newest run wins and a tombstone hides the older put", () => {
    const older = encodeSst([
      { kind: "put", key: utf("a"), value: utf("old") },
      { kind: "put", key: utf("b"), value: utf("1") },
    ]);
    const newer = encodeSst([
      { kind: "put", key: utf("a"), value: utf("new") },
      { kind: "del", key: utf("b") },
    ]);
    const readers = [new SstReader(newer), new SstReader(older)];
    expect(pointGet(undefined, readers, utf("a"))).toEqual(utf("new"));
    expect(pointGet(undefined, readers, utf("b"))).toBeUndefined();
    expect(pointGet(undefined, readers, utf("c"))).toBeUndefined();
  });

  it("cursor seeks one block and stops before endExclusive", () => {
    const entries = Array.from({ length: 80 }, (_, i) => ({
      kind: "put" as const,
      key: utf(`k${String(i).padStart(3, "0")}`),
      value: utf(`v${i}`),
    }));
    const reader = new SstReader(encodeSst(entries, 200));
    const cur = reader.cursor({
      start: utf("k040"),
      endExclusive: utf("k043"),
    });
    const got: string[] = [];
    for (;;) {
      const e = cur.peek();
      if (!e) break;
      got.push(new TextDecoder().decode(e.key));
      cur.next();
    }
    expect(got).toEqual(["k040", "k041", "k042"]);
  });

  it("default block target constant is 4KiB", () => {
    expect(SST_BLOCK_TARGET).toBe(4096);
  });
});

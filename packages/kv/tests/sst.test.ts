import { describe, expect, it } from "vitest";
import { CorruptDatabaseError } from "../src/errors.js";
import {
  decodeSst,
  encodeSst,
  SstReader,
  SST_BLOCK_TARGET,
} from "../src/store/sst.js";
import { pointGet, runLevels } from "../src/store/merge.js";

const enc = new TextEncoder();
const utf = (s: string) => enc.encode(s);

/** Two entries (put a=1, del b) written by the v2 encoder, before records carried a seq. */
const V2_FIXTURE =
  "54534c4f02000000020000000100000015000000070008008d008209207040000200000001010000006101000000310201000000620100000061010000006200000000150000001e2bc0b9";

/** The same two entries with seqs 7 and 9, written by the v3 encoder, before Bloom header fields were u32. */
const V3_FIXTURE =
  "54534c4f03000000020000000100000025000000070008008d008209207040000200000001070000000000000001000000610100000031020900000000000000010000006201000000610100000062000000002500000028972ab1";

/** The same two entries, written by the v4 encoder, before the Bloom filter and index moved behind the data. */
const V4_FIXTURE =
  "54534c4f0400000002000000010000002500000007000000080000008d008209207040000200000001070000000000000001000000610100000031020900000000000000010000006201000000610100000062000000002500000074971cb3";

/** The same two entries, written by the v5 encoder, before the footer had a codec. */
const V5_FIXTURE =
  "020000000107000000000000000100000061010000003102090000000000000001000000628d0082092070400001000000610100000062000000002500000002000000010000002500000008000000070000002d00000012000000ee9a880b0500000054534c4f";

/** The same two entries, written by the v6 encoder, before blocks shared a key prefix. */
const V6_FIXTURE =
  "020000000107000000000000000100000061010000003102090000000000000001000000628d0082092070400001000000610100000062000000002500000002000000010000002500000008000000070000002d0000001200000000000000fa1fe8830600000054534c4f";

const drainKeys = (r: SstReader) => {
  const c = r.cursor();
  const out: string[] = [];
  for (let e = c.peek(); e; c.next(), e = c.peek()) out.push(new TextDecoder().decode(e.key));
  return out;
};
const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((h) => parseInt(h, 16)));

describe("sst", () => {
  it("reads back a run whose Bloom filter is over 64 KiB", () => {
    const n = 60_000;
    const entries = Array.from({ length: n }, (_, i) => ({
      kind: "put" as const,
      key: utf(`k${String(i).padStart(8, "0")}`),
      value: utf("v"),
      seq: i + 1,
    }));
    const body = encodeSst(entries);
    expect(decodeSst(body)).toHaveLength(n);
    const reader = new SstReader(body);
    expect(reader.get(utf("k00059999"))?.seq).toBe(n);
    expect(reader.get(utf("k00060000"))).toBeUndefined();
  });

  it("reads a v3 run with its seqs", () => {
    expect(decodeSst(hex(V3_FIXTURE)).map((e) => e.seq)).toEqual([7, 9]);
    expect(new SstReader(hex(V3_FIXTURE)).get(utf("b"))?.seq).toBe(9);
  });

  it("reads a v4 run with its seqs", () => {
    expect(decodeSst(hex(V4_FIXTURE)).map((e) => e.seq)).toEqual([7, 9]);
    expect(new SstReader(hex(V4_FIXTURE)).get(utf("a"))?.seq).toBe(7);
  });

  it("reads a v5 run with its seqs", () => {
    expect(decodeSst(hex(V5_FIXTURE)).map((e) => e.seq)).toEqual([7, 9]);
    expect(new SstReader(hex(V5_FIXTURE)).get(utf("b"))?.kind).toBe("del");
  });

  it("reads a v6 run with its seqs", () => {
    expect(decodeSst(hex(V6_FIXTURE)).map((e) => e.seq)).toEqual([7, 9]);
    expect(new SstReader(hex(V6_FIXTURE)).get(utf("a"))?.seq).toBe(7);
    expect(drainKeys(new SstReader(hex(V6_FIXTURE)))).toEqual(["a", "b"]);
  });

  it("writes the data first and the footer last", () => {
    const body = encodeSst([{ kind: "put", key: utf("a"), value: utf("1"), seq: 7 }]);
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    expect(view.getUint32(0, true)).toBe(1); // first block's record count
    expect(view.getUint32(body.byteLength - 8, true)).toBe(7); // version
    expect(view.getUint32(body.byteLength - 4, true)).toBe(0x4f4c5354); // magic
  });

  it("round-trips each entry's seq", () => {
    const body = encodeSst([
      { kind: "put", key: utf("a"), value: utf("1"), seq: 7 },
      { kind: "del", key: utf("b"), seq: 2 ** 40 },
    ]);
    expect(decodeSst(body).map((e) => e.seq)).toEqual([7, 2 ** 40]);
    expect(new SstReader(body).get(utf("b"))).toEqual({ kind: "del", key: utf("b"), seq: 2 ** 40 });
  });

  it("reads a v2 run, with seq 0", () => {
    const body = hex(V2_FIXTURE);
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
    body[5] ^= 0xff;
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
    expect(view.getUint32(body.byteLength - 40, true)).toBeGreaterThan(1); // blockCount
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

  it("get finds what a full decode holds, for every key and gap", async () => {
    const { encodeSst: encodeWasm } = await import("../src/store/engine.js");
    const { sstGet } = await import("../src/store/sst.js");
    const rows = Array.from({ length: 900 }, (_, i) =>
      i % 7 === 3
        ? { kind: "del" as const, key: utf(`k${String(i * 2).padStart(5, "0")}`), seq: i + 1 }
        : { kind: "put" as const, key: utf(`k${String(i * 2).padStart(5, "0")}`), value: utf("v".repeat(i % 50)), seq: i + 1 },
    );
    const runs = [encodeSst(rows), await encodeWasm(rows, "lz4"), hex(V2_FIXTURE), hex(V5_FIXTURE)];
    const probes = [utf(""), utf("a"), utf("b"), utf("c"), utf("k"), utf("z")];
    for (let i = 0; i <= 1800; i++) probes.push(utf(`k${String(i).padStart(5, "0")}`), utf(`k${String(i).padStart(5, "0")}x`));
    const show = (e: ReturnType<typeof sstGet>) =>
      e && `${new TextDecoder().decode(e.key)}:${e.kind}:${e.seq}:${e.kind === "put" ? e.value.byteLength : ""}`;
    for (const body of runs) {
      const all = decodeSst(body);
      const reader = new SstReader(body);
      for (const k of probes) expect(show(reader.get(k))).toBe(show(sstGet(all, k)));
    }
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
    const levels = runLevels(["l0/2-2.sst", "l0/1-1.sst"], [new SstReader(newer), new SstReader(older)]);
    expect(pointGet(undefined, levels, utf("a"))).toEqual(utf("new"));
    expect(pointGet(undefined, levels, utf("b"))).toBeUndefined();
    expect(pointGet(undefined, levels, utf("c"))).toBeUndefined();
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

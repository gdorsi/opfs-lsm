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

  it("writes the data first and the footer last", () => {
    const body = encodeSst([{ kind: "put", key: utf("a"), value: utf("1"), seq: 7 }]);
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    expect(view.getUint32(0, true)).toBe(1); // first block's record count
    expect(view.getUint32(body.byteLength - 8, true)).toBe(1); // version
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

  it("rejects a footer whose version is not 1", () => {
    const body = encodeSst([{ kind: "put", key: utf("a"), value: utf("1"), seq: 7 }]);
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    view.setUint32(body.byteLength - 8, 7, true);
    expect(() => decodeSst(body)).toThrow(/unsupported sst version 7/);
    expect(() => new SstReader(body)).toThrow(/unsupported sst version 7/);
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
    const runs = [encodeSst(rows), await encodeWasm(rows, "lz4")];
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

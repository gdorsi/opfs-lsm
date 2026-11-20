import { describe, expect, it } from "vitest";
import { CorruptDatabaseError } from "../src/errors.js";
import { untilHit } from "../src/store/cursor.js";
import { decodeSst, encodeSstRef, sstGet, SST_BLOCK_TARGET } from "./oracle/sst-ref.js";
import { pointGet, runLevels } from "../src/store/read.js";
import { PageCache } from "../src/store/page-cache.js";
import { SstReader } from "../src/store/sst-reader.js";
import { bytesFile, drain, readerOfBytes, runGet } from "./runs.js";
import { NO_MARKS } from "../src/store/marks.js";

const enc = new TextEncoder();
const utf = (s: string) => enc.encode(s);

describe("sst", () => {
  it("reads back a run whose Bloom filter is over 64 KiB", async () => {
    const n = 60_000;
    const entries = Array.from({ length: n }, (_, i) => ({
      kind: "put" as const,
      key: utf(`k${String(i).padStart(8, "0")}`),
      value: utf("v"),
      seq: i + 1,
    }));
    const body = encodeSstRef(entries);
    expect(decodeSst(body)).toHaveLength(n);
    const reader = readerOfBytes(body);
    expect((await runGet(reader, utf("k00059999")))?.seq).toBe(n);
    expect(await runGet(reader, utf("k00060000"))).toBeUndefined();
  });

  it("writes the data first and the footer last", () => {
    const body = encodeSstRef([{ kind: "put", key: utf("a"), value: utf("1"), seq: 7 }]);
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    expect(view.getUint32(0, true)).toBe(1); // first block's record count
    expect(view.getUint32(body.byteLength - 8, true)).toBe(1); // version
    expect(view.getUint32(body.byteLength - 4, true)).toBe(0x4f4c5354); // magic
  });

  it("round-trips each entry's seq", async () => {
    const body = encodeSstRef([
      { kind: "put", key: utf("a"), value: utf("1"), seq: 7 },
      { kind: "del", key: utf("b"), seq: 2 ** 40 },
    ]);
    expect(decodeSst(body).map((e) => e.seq)).toEqual([7, 2 ** 40]);
    const reader = readerOfBytes(body);
    expect(await runGet(reader, utf("b"))).toEqual({ kind: "del", key: utf("b"), seq: 2 ** 40 });
  });

  it("reads a seq exactly up to the largest safe integer, in a get and in a scan", async () => {
    const seqs = [1, 2 ** 32 - 1, 2 ** 32, 2 ** 32 + 1, 2 ** 40 + 5, 2 ** 53 - 2, Number.MAX_SAFE_INTEGER];
    const key = (i: number) => utf(`k${i}`);
    const reader = readerOfBytes(encodeSstRef(seqs.map((seq, i) => ({ kind: "put" as const, key: key(i), value: utf("v"), seq }))));
    const got = await Promise.all(seqs.map((_, i) => runGet(reader, key(i))));
    expect(got.map((e) => e?.seq)).toEqual(seqs);
    expect((await drain(reader.cursor())).map((e) => e.seq)).toEqual(seqs);
  });

  it("rejects a footer whose version is not 1", async () => {
    const body = encodeSstRef([{ kind: "put", key: utf("a"), value: utf("1"), seq: 7 }]);
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    view.setUint32(body.byteLength - 8, 7, true);
    expect(() => decodeSst(body)).toThrow(/unsupported sst version 7/);
    const reader = new SstReader(bytesFile(body), new PageCache(), undefined);
    await expect(runGet(reader, utf("a"))).rejects.toThrow(/unsupported sst version 7/);
  });

  it("round-trips puts and deletes", () => {
    const body = encodeSstRef([
      { kind: "put", key: utf("b"), value: utf("2"), seq: 1 },
      { kind: "del", key: utf("a"), seq: 2 },
      { kind: "put", key: utf("c"), value: utf("3"), seq: 3 },
    ]);
    const entries = decodeSst(body);
    expect(entries.map((e) => e.kind + ":" + new TextDecoder().decode(e.key))).toEqual([
      "del:a",
      "put:b",
      "put:c",
    ]);
  });

  it("rejects corrupt crc", () => {
    const body = encodeSstRef([{ kind: "put", key: utf("a"), value: utf("1"), seq: 1 }]);
    body[5] ^= 0xff;
    expect(() => decodeSst(body)).toThrow(CorruptDatabaseError);
  });

  it("splits into multiple blocks", () => {
    const entries = Array.from({ length: 200 }, (_, i) => ({
      kind: "put" as const,
      key: utf(`k${String(i).padStart(4, "0")}`),
      value: utf(`v${i}`),
      seq: i + 1,
    }));
    const body = encodeSstRef(entries, 256);
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    expect(view.getUint32(body.byteLength - 40, true)).toBeGreaterThan(1); // blockCount
    expect(decodeSst(body)).toHaveLength(200);
  });

  it("SstReader point-gets via bloom + one block", async () => {
    const entries = Array.from({ length: 80 }, (_, i) => ({
      kind: "put" as const,
      key: utf(`k${String(i).padStart(3, "0")}`),
      value: utf(`v${i}`),
      seq: i + 1,
    }));
    const body = encodeSstRef(entries, 200);
    const reader = readerOfBytes(body);
    expect(await runGet(reader, utf("k040"))).toEqual({
      kind: "put",
      key: utf("k040"),
      value: utf("v40"),
      seq: 41,
    });
    expect(await runGet(reader, utf("missing"))).toBeUndefined();
  });

  it("get finds what a full decode holds, for every key and gap", async () => {
    const { encodeRun } = await import("../src/store/engine.js");
    const rows = Array.from({ length: 900 }, (_, i) =>
      i % 7 === 3
        ? { kind: "del" as const, key: utf(`k${String(i * 2).padStart(5, "0")}`), seq: i + 1 }
        : { kind: "put" as const, key: utf(`k${String(i * 2).padStart(5, "0")}`), value: utf("v".repeat(i % 50)), seq: i + 1 },
    );
    const runs = [encodeSstRef(rows), (await encodeRun(rows, "lz4")).body];
    const probes = [utf(""), utf("a"), utf("b"), utf("c"), utf("k"), utf("z")];
    for (let i = 0; i <= 1800; i++) probes.push(utf(`k${String(i).padStart(5, "0")}`), utf(`k${String(i).padStart(5, "0")}x`));
    const show = (e: ReturnType<typeof sstGet>) =>
      e && `${new TextDecoder().decode(e.key)}:${e.kind}:${e.seq}:${e.kind === "put" ? e.value.byteLength : ""}`;
    for (const body of runs) {
      const all = decodeSst(body);
      const reader = readerOfBytes(body);
      for (const k of probes) expect(show(await runGet(reader, k))).toBe(show(sstGet(all, k)));
    }
  });

  it("newest run wins and a tombstone hides the older put", async () => {
    const older = encodeSstRef([
      { kind: "put", key: utf("a"), value: utf("old"), seq: 1 },
      { kind: "put", key: utf("b"), value: utf("1"), seq: 1 },
    ]);
    const newer = encodeSstRef([
      { kind: "put", key: utf("a"), value: utf("new"), seq: 2 },
      { kind: "del", key: utf("b"), seq: 2 },
    ]);
    const levels = runLevels(["l0/2-2.sst", "l0/1-1.sst"], [readerOfBytes(newer), readerOfBytes(older)]);
    expect(await untilHit(() => pointGet(undefined, levels, utf("a"), NO_MARKS))).toEqual(utf("new"));
    expect(await untilHit(() => pointGet(undefined, levels, utf("b"), NO_MARKS))).toBeUndefined();
    expect(await untilHit(() => pointGet(undefined, levels, utf("c"), NO_MARKS))).toBeUndefined();
  });

  it("cursor seeks one block and stops before endExclusive", async () => {
    const entries = Array.from({ length: 80 }, (_, i) => ({
      kind: "put" as const,
      key: utf(`k${String(i).padStart(3, "0")}`),
      value: utf(`v${i}`),
      seq: i + 1,
    }));
    const reader = readerOfBytes(encodeSstRef(entries, 200));
    const got = (await drain(reader.cursor({ start: utf("k040"), endExclusive: utf("k043") }))).map((e) =>
      new TextDecoder().decode(e.key),
    );
    expect(got).toEqual(["k040", "k041", "k042"]);
  });

  it("default block target constant is 4KiB", () => {
    expect(SST_BLOCK_TARGET).toBe(4096);
  });
});

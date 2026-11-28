import { describe, expect, it } from "vitest";
import { CorruptDatabaseError } from "../src/errors.js";
import { untilHit } from "../src/store/cursor.js";
import { decodeSst, encodeSstRef, sstBlockIndex, sstRunEnd } from "./oracle/sst-ref.js";
import { pointGet, runLevels } from "../src/store/read.js";
import { PageCache } from "../src/store/page-cache.js";
import { SstReader } from "../src/store/sst-reader.js";
import { SST_FOOTER_BYTES } from "../src/store/sst.js";
import { bytesFile, cacheUsage, drain, loadsDone, readerOfBytes, runGet } from "./runs.js";
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

  it("writes the data first and the footer last, with the Bloom filter and no index between them", () => {
    const body = encodeSstRef([{ kind: "put", key: utf("a"), value: utf("1"), seq: 7 }]);
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    expect(view.getUint32(0, true)).toBe(1); // first block's record count
    expect(view.getUint32(body.byteLength - 8, true)).toBe(3); // version
    expect(view.getUint32(body.byteLength - 4, true)).toBe(0x4f4c5354); // magic
    // One block, the 8 bytes of a one-key Bloom filter, and the footer.
    expect(body.byteLength).toBe(sstBlockIndex(body).blockStart[1]! + 8 + SST_FOOTER_BYTES);
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

  it("rejects a footer whose version is not 3, and a tab reads the run without its Bloom filter", async () => {
    const body = encodeSstRef([{ kind: "put", key: utf("a"), value: utf("1"), seq: 7 }]);
    const end = sstRunEnd(body);
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    view.setUint32(body.byteLength - 8, 2, true);
    expect(() => decodeSst(body)).toThrow(/unsupported sst version 2/);
    const cache = new PageCache();
    const reader = new SstReader(bytesFile(body), cache, end);
    expect(await runGet(reader, utf("a"))).toEqual({ kind: "put", key: utf("a"), value: utf("1"), seq: 7 });
    await loadsDone(cache);
    expect(cacheUsage(cache).metadata).toBe(0);
  });

  it("fails every read of a file that is not the size its manifest entry records, and reads none of it", async () => {
    const body = encodeSstRef([{ kind: "put", key: utf("a"), value: utf("1"), seq: 7 }]);
    for (const size of [body.byteLength - 1, body.byteLength + 1]) {
      let reads = 0;
      const file = { size, read: async () => (reads++, body) };
      const reader = new SstReader(file, new PageCache(), sstRunEnd(body));
      await expect(runGet(reader, utf("a"))).rejects.toThrow(CorruptDatabaseError);
      await expect(drain(reader.cursor())).rejects.toThrow(CorruptDatabaseError);
      expect(reads).toBe(0);
    }
  });

  it("rejects corrupt crc", () => {
    const body = encodeSstRef([{ kind: "put", key: utf("a"), value: utf("1"), seq: 1 }]);
    body[5] ^= 0xff;
    expect(() => decodeSst(body)).toThrow(CorruptDatabaseError);
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
    const levels = runLevels([0, 0], [readerOfBytes(newer), readerOfBytes(older)]);
    expect(await untilHit(() => pointGet(undefined, levels, utf("a"), NO_MARKS))).toEqual(utf("new"));
    expect(await untilHit(() => pointGet(undefined, levels, utf("b"), NO_MARKS))).toBeUndefined();
    expect(await untilHit(() => pointGet(undefined, levels, utf("c"), NO_MARKS))).toBeUndefined();
  });

});

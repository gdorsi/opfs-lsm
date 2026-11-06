import { beforeAll, describe, expect, it } from "vitest";
import { encodeSst as encodeWasm, engineUsingWasm, ensureEngine } from "../src/store/engine.js";
import { decodeSst, encodeSst, sstGet, type SstEntry } from "../src/store/sst.js";
import { settle, type ScanBounds } from "../src/store/cursor.js";
import { compareBytes } from "../src/bytes.js";
import { cat, EDGE_CASES, indexWorkload, utf } from "./sst-workloads.js";
import { drain, readerOfBytes } from "./runs.js";

/** `toEqual` walks typed arrays element by element, which is too slow for thousands of entries. */
const show = (e: SstEntry | undefined) => (e ? `${[...e.key]}:${e.kind}:${e.seq}:${e.kind === "put" ? [...e.value] : ""}` : "none");

async function expectReaderAgreesWithDecode(body: Uint8Array): Promise<void> {
  const all = decodeSst(body);
  const reader = readerOfBytes(body);
  const get = (k: Uint8Array) => settle(() => reader.get(k));
  expect((await Promise.all(all.map((e) => get(e.key)))).map(show)).toEqual(all.map(show));
  const misses = [...all.map((e) => cat(e.key, Uint8Array.of(0))), utf("i/")];
  expect((await Promise.all(misses.map(get))).map(show)).toEqual(misses.map((k) => show(sstGet(all, k))));
  const asLayer = (bounds: ScanBounds) =>
    all
      .filter(
        (e) =>
          (!bounds.start || compareBytes(e.key, bounds.start) >= 0) &&
          (!bounds.endExclusive || compareBytes(e.key, bounds.endExclusive) < 0),
      )
      .map((e) => `${[...e.key]}:${e.kind}:${e.kind === "put" ? [...e.value] : ""}`);
  const ranges: ScanBounds[] = [{}];
  if (all.length > 2) {
    const third = all[Math.floor(all.length / 3)]!.key;
    const twoThirds = all[Math.floor((2 * all.length) / 3)]!.key;
    ranges.push({ start: third }, { endExclusive: twoThirds }, { start: third, endExclusive: twoThirds });
    ranges.push({ start: cat(third, Uint8Array.of(0)), endExclusive: cat(twoThirds, Uint8Array.of(0)) });
  }
  for (const bounds of ranges) {
    const got = (await drain(reader.cursor(bounds))).map((e) => `${[...e.key]}:${e.kind}:${e.value ? [...e.value] : ""}`);
    expect(got).toEqual(asLayer(bounds));
  }
}

describe("sst format", () => {
  beforeAll(async () => {
    await ensureEngine();
    expect(engineUsingWasm()).toBe(true);
  });

  const cases: [string, SstEntry[]][] = [["multi-index workload", indexWorkload(2_000)], ...Object.entries(EDGE_CASES)];

  for (const [name, entries] of cases) {
    it(`the TS and wasm encoders write the same bytes: ${name}`, async () => {
      expect(encodeSst(entries)).toEqual(await encodeWasm(entries, "raw"));
    });

    it(`SstReader get and cursor agree with decodeSst: ${name}`, async () => {
      const sorted = [...entries].sort((a, b) => compareBytes(a.key, b.key));
      for (const body of [encodeSst(entries), await encodeWasm(entries, "lz4")]) {
        expect(decodeSst(body).map(show)).toEqual(sorted.map((e) => show({ ...e, seq: e.seq ?? 0 })));
        await expectReaderAgreesWithDecode(body);
      }
    });
  }

  it("stores the multi-index workload in less than half the whole-key record bytes", () => {
    const entries = indexWorkload(2_000).filter((e) => e.key[0] === 0x69);
    const wholeKey = entries.reduce((n, e) => n + 1 + 8 + 4 + e.key.byteLength + (e.kind === "put" ? 4 + e.value.byteLength : 0), 0);
    expect(encodeSst(entries).byteLength).toBeLessThan(wholeKey / 2);
  });

  it("fills blocks to the target in encoded bytes", () => {
    const body = encodeSst(indexWorkload(2_000));
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const blocks = view.getUint32(body.byteLength - 40, true);
    const dataLen = view.getUint32(body.byteLength - 36, true);
    expect(dataLen / blocks).toBeGreaterThan(4096 * 0.9);
    expect(dataLen / blocks).toBeLessThanOrEqual(4096);
  });
});

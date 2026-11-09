import { beforeAll, describe, expect, it } from "vitest";
import { encodeSst as encodeWasm, engineUsingWasm, ensureEngine } from "../src/store/engine.js";
import { decodeSst, encodeSst, sstGet, type SstEntry } from "../src/store/sst.js";
import { Miss, settle, type LayerEntry, type ScanBounds } from "../src/store/cursor.js";
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
  if (all.length > 0) {
    const first = all[0]!.key;
    const last = all[all.length - 1]!.key;
    ranges.push(
      { start: first },
      { start: last },
      { endExclusive: first },
      { endExclusive: last },
      { endExclusive: cat(last, Uint8Array.of(0)) },
      { start: cat(first, Uint8Array.of(0)), endExclusive: last },
      { start: last, endExclusive: first },
    );
  }
  const shown = (es: LayerEntry[]) => es.map((e) => `${[...e.key]}:${e.kind}:${e.value ? [...e.value] : ""}`);
  for (const bounds of ranges) {
    const forward = shown(await drain(reader.cursor(bounds)));
    expect(forward).toEqual(asLayer(bounds));
    expect(shown(await drain(reader.cursor(bounds, true)))).toEqual([...forward].reverse());
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

  it("reads blocks of a single record backward", async () => {
    const entries = indexWorkload(40);
    const body = encodeSst(entries, 1);
    expect(new DataView(body.buffer).getUint32(body.byteLength - 40, true)).toBe(entries.length);
    const sorted = decodeSst(body);
    const keys = sorted.map((e) => e.key);
    const reader = readerOfBytes(body);
    const bounds: ScanBounds[] = [
      {},
      { start: keys[5]!, endExclusive: keys[20]! },
      { start: cat(keys[5]!, Uint8Array.of(0)), endExclusive: cat(keys[20]!, Uint8Array.of(0)) },
      { start: keys[keys.length - 1]! },
      { endExclusive: keys[1]! },
    ];
    for (const b of bounds) {
      const forward = (await drain(reader.cursor(b))).map((e) => [...e.key].join());
      expect(forward.length).toBeGreaterThan(0);
      expect((await drain(reader.cursor(b, true))).map((e) => [...e.key].join())).toEqual([...forward].reverse());
    }
  });

  it("leaves a cursor where it was when a block boundary misses, in both directions", async () => {
    const body = encodeSst(indexWorkload(300), 256);
    const keysOf = (es: LayerEntry[]) => es.map((e) => [...e.key].join());
    for (const reverse of [false, true]) {
      const reader = readerOfBytes(body);
      const want = keysOf(await drain(reader.cursor()));
      if (reverse) want.reverse();
      const cursor = reader.cursor(undefined, reverse);
      const got: string[] = [];
      let misses = 0;
      for (;;) {
        const e = cursor.peek();
        if (e instanceof Miss) {
          misses++;
          await e.ready;
          reader.close();
          continue;
        }
        if (!e) break;
        got.push([...e.key].join());
        cursor.next();
      }
      expect(got).toEqual(want);
      expect(misses).toBeGreaterThan(10);
    }
  });

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

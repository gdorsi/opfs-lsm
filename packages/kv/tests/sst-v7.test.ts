import { beforeAll, describe, expect, it } from "vitest";
import { encodeSst as encodeWasm, engineUsingWasm, ensureEngine } from "../src/store/engine.js";
import { decodeSst, encodeSst, SstReader, sstGet, type SstEntry } from "../src/store/sst.js";
import type { LayerCursor, ScanBounds } from "../src/store/cursor.js";
import { compareBytes } from "../src/bytes.js";

const enc = new TextEncoder();
const utf = (s: string) => enc.encode(s);

/** u16le length + UTF-8, as collections encodes key segments. */
const seg = (s: string) => {
  const body = utf(s);
  return Uint8Array.of(body.byteLength & 0xff, body.byteLength >> 8, ...body);
};
const cat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));

/**
 * A primary row and one key per index, shaped like collections' keys:
 * `i/` + table + index + typed value(s) + id, with an empty value.
 */
function indexWorkload(rows: number): SstEntry[] {
  const out: SstEntry[] = [];
  let seq = 1;
  for (let i = 0; i < rows; i++) {
    const id = seg(`row-${(i * 7919) % rows}`);
    const ts = new Uint8Array(9);
    ts[0] = 0x20;
    new DataView(ts.buffer).setFloat64(1, 1_700_000_000_000 + i * 1000);
    const index = (name: string, ...value: Uint8Array[]) =>
      out.push({ kind: "put", key: cat(utf("i/"), seg("todos"), seg(name), ...value, id), value: new Uint8Array(0), seq: seq++ });
    out.push({ kind: "put", key: cat(utf("t/"), seg("todos"), id), value: utf(`{"title":"buy milk ${i}"}`), seq: seq++ });
    index("byDone", Uint8Array.of(0x10, i % 4 === 0 ? 1 : 0));
    index("byCreatedAt", ts);
    index("byOrgCreated", seg(`org-${i % 40}`), ts);
    for (const tag of ["home", "work", "urgent"].slice(0, 1 + (i % 3))) index("byTag", seg(tag));
    if (i % 11 === 0) out.push({ kind: "del", key: cat(utf("i/"), seg("todos"), seg("byGone"), id), seq: seq++ });
  }
  return out;
}

const put = (key: Uint8Array, value: Uint8Array, seq = 1): SstEntry => ({ kind: "put", key, value, seq });

const EDGE_CASES: Record<string, SstEntry[]> = {
  "empty run": [],
  "single key": [put(utf("only"), utf("v"))],
  "empty key": [put(new Uint8Array(0), utf("first")), put(utf("a"), new Uint8Array(0), 2)],
  "no common prefix": [put(utf("apple"), utf("1")), put(utf("mango"), utf("2")), { kind: "del", key: utf("zebra"), seq: 3 }],
  "one key prefixes the next": [put(utf("ab"), utf("1")), put(utf("abc"), utf("2")), put(utf("abcd"), utf("3"))],
  "lengths past one varint byte": [
    put(new Uint8Array(300).fill(0xff), new Uint8Array(200).fill(7), 2 ** 40),
    put(new Uint8Array(301).fill(0xff), new Uint8Array(20_000).fill(9)),
  ],
  "a record past u16 offsets between small ones": [
    put(utf("a"), utf("1")),
    put(utf("b"), new Uint8Array(70_000).fill(5), 2),
    ...Array.from({ length: 40 }, (_, i) => put(utf(`c${String(i).padStart(3, "0")}`), utf("v"), 3 + i)),
  ],
  "keys that differ only past the sampled records": Array.from({ length: 200 }, (_, i) =>
    put(cat(new Uint8Array(40).fill(0x61), utf(String(i * 3).padStart(5, "0"))), new Uint8Array(0), i + 1),
  ),
};

function drain(c: LayerCursor): string[] {
  const out: string[] = [];
  for (let e = c.peek(); e; c.next(), e = c.peek()) out.push(`${[...e.key]}:${e.kind}:${e.value ? [...e.value] : ""}`);
  return out;
}

function expectReaderAgreesWithDecode(body: Uint8Array): void {
  const all = decodeSst(body);
  const reader = new SstReader(body);
  for (const e of all) expect(reader.get(e.key)).toEqual(e);
  for (const e of all) expect(reader.get(cat(e.key, Uint8Array.of(0)))).toEqual(sstGet(all, cat(e.key, Uint8Array.of(0))));
  expect(reader.get(utf("i/"))).toEqual(sstGet(all, utf("i/")));
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
  for (const bounds of ranges) expect(drain(reader.cursor(bounds))).toEqual(asLayer(bounds));
}

describe("sst v7", () => {
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
        expect(decodeSst(body)).toEqual(sorted.map((e) => ({ ...e, seq: e.seq ?? 0 })));
        expectReaderAgreesWithDecode(body);
      }
    });
  }

  it("stores the multi-index workload in less than half the v6 record bytes", () => {
    const entries = indexWorkload(2_000).filter((e) => e.key[0] === 0x69);
    const v6 = entries.reduce((n, e) => n + 1 + 8 + 4 + e.key.byteLength + (e.kind === "put" ? 4 + e.value.byteLength : 0), 0);
    expect(encodeSst(entries).byteLength).toBeLessThan(v6 / 2);
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

import { beforeAll, describe, expect, it } from "vitest";
import { containsAll } from "../src/bytes.js";
import { CorruptDatabaseError } from "../src/errors.js";
import { encodeSst, engineUsingWasm, ensureEngine } from "../src/store/engine.js";
import { useBlockScanner } from "../src/store/block-scan.js";
import { RunLevel } from "../src/store/merge.js";
import { SstReader, type SstEntry } from "../src/store/sst.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

const entries: SstEntry[] = [
  ...Array.from({ length: 600 }, (_, i) => ({
    kind: "put" as const,
    key: enc.encode(`k/${String(i).padStart(5, "0")}`),
    value: enc.encode(` w${i % 7} c${i % 3}`),
    seq: i + 1,
  })),
  { kind: "del", key: enc.encode("k/00007z"), seq: 999 },
];

const pats = (...s: string[]) => s.map((x) => enc.encode(x));
const keys = (rows: Iterable<{ key: Uint8Array }>) => [...rows].map((r) => dec.decode(r.key));

function expected(reader: SstReader, patterns: Uint8Array[], bounds?: { start?: Uint8Array; endExclusive?: Uint8Array }) {
  const out: string[] = [];
  const c = reader.cursor(bounds);
  for (let e = c.peek(); e; c.next(), e = c.peek()) {
    if (e.kind === "put" && containsAll(e.value!, patterns)) out.push(dec.decode(e.key));
  }
  return out;
}

beforeAll(async () => {
  await ensureEngine();
  expect(engineUsingWasm()).toBe(true);
});

describe.each(["raw", "lz4"] as const)("SstReader.scanContains (%s)", (codec) => {
  it("matches what the cursor filter gives, over several blocks and bounds", async () => {
    const reader = new SstReader(await encodeSst(entries, codec));
    for (const patterns of [pats(" w3"), pats(" w3", " c0"), pats(" nope"), pats(" w")]) {
      for (const bounds of [undefined, { start: enc.encode("k/00100") }, { endExclusive: enc.encode("k/00450") }, { start: enc.encode("k/00123"), endExclusive: enc.encode("k/00321") }]) {
        expect(keys(reader.scanContains(patterns, bounds))).toEqual(expected(reader, patterns, bounds));
      }
    }
    expect(keys(reader.scanContains(pats(" w0")))).not.toContain("k/00007z");
  });

  it("falls back to the cursor when no wasm scanner is installed", async () => {
    const reader = new SstReader(await encodeSst(entries, codec));
    const prev = useBlockScanner(undefined);
    try {
      expect(keys(reader.scanContains(pats(" w3", " c0")))).toEqual(expected(reader, pats(" w3", " c0")));
    } finally {
      useBlockScanner(prev);
    }
  });

  it("reports a corrupt block as CorruptDatabaseError", async () => {
    const sst = await encodeSst(entries, codec);
    const head = new DataView(sst.buffer, sst.byteOffset);
    head.setUint32(0, head.getUint32(0, true) + 1, true);
    expect(() => [...new SstReader(sst).scanContains(pats(" w3"))]).toThrow(CorruptDatabaseError);
  });

  it("walks every run of a level in key order", async () => {
    const half = entries.length >> 1;
    const lo = new SstReader(await encodeSst(entries.slice(0, half), codec));
    const hi = new SstReader(await encodeSst(entries.slice(half), codec));
    const level = new RunLevel([lo, hi]);
    const bounds = { start: enc.encode("k/00200"), endExclusive: enc.encode("k/00400") };
    expect(keys(level.scanContains(pats(" w3"), bounds))).toEqual(expected(lo, pats(" w3"), bounds).concat(expected(hi, pats(" w3"), bounds)));
  });
});

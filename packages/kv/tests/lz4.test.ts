import { describe, expect, it } from "vitest";
import { CorruptDatabaseError } from "../src/errors.js";
import { mergeNextStep } from "../src/host/compact.js";
import { MemoryFs } from "../src/index.js";
import { decodeSst as decodeWasm, encodeSst, engineUsingWasm, ensureEngine } from "../src/store/engine.js";
import { publishGeneration, publishRun, runMeta } from "../src/store/generation.js";
import { lz4DecompressJs, useLz4Decoder } from "../src/store/lz4.js";
import { decodeSst, SstReader, type SstEntry } from "../src/store/sst.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const key = (i: number) => enc.encode(`k/${String(i).padStart(6, "0")}`);

let seed = 1;
function noise(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    out[i] = seed >>> 24;
  }
  return out;
}

/** Values that hit each LZ4 path: short and long literals, short, long and overlapping matches. */
function mixedRows(): SstEntry[] {
  const values = [
    () => enc.encode(`{"title":"buy milk","done":false}`),
    () => noise(40),
    () => noise(300),
    () => new Uint8Array(5_000).fill(7),
    () => enc.encode("ab".repeat(2_000)),
    () => noise(70_000),
    () => new Uint8Array(0),
  ];
  return Array.from({ length: 700 }, (_, i): SstEntry =>
    i % 11 === 0
      ? { kind: "del", key: key(i), seq: i + 1 }
      : { kind: "put", key: key(i), value: values[i % values.length]!(), seq: i + 1 },
  );
}

function hash(b: Uint8Array): number {
  let h = 0x811c9dc5;
  for (const x of b) h = Math.imul(h ^ x, 0x01000193);
  return h >>> 0;
}

type Row = { key: Uint8Array; kind: string; value?: Uint8Array; seq?: number };
const show = (rows: readonly (Row | undefined)[]) =>
  rows.map((r) => r && `${dec.decode(r.key)}:${r.kind}:${r.seq ?? ""}:${r.value ? `${r.value.byteLength}/${hash(r.value)}` : ""}`);

describe("LZ4 runs", () => {
  it("read back the same rows as a raw run", async () => {
    await ensureEngine();
    expect(engineUsingWasm()).toBe(true);
    const rows = mixedRows();
    const raw = await encodeSst(rows, "raw");
    const packed = await encodeSst(rows, "lz4");
    expect(packed.byteLength).toBeLessThan(raw.byteLength);
    const want = show(decodeSst(raw));
    expect(show(decodeSst(packed))).toEqual(want);
    expect(show(await decodeWasm(packed))).toEqual(want);

    const a = new SstReader(raw);
    const b = new SstReader(packed);
    expect(b.range).toEqual(a.range);
    const keys = Array.from({ length: 703 }, (_, i) => key(i - 1));
    expect(show(keys.map((k) => b.get(k)))).toEqual(show(keys.map((k) => a.get(k))));
    const scan = (r: SstReader, start?: Uint8Array) => {
      const out = [];
      const c = r.cursor(start ? { start } : undefined);
      for (let e = c.peek(); e; c.next(), e = c.peek()) out.push(e);
      return show(out);
    };
    expect(scan(b)).toEqual(scan(a));
    expect(scan(b, key(333))).toEqual(scan(a, key(333)));
  });

  it("read back the same rows with the JS decoder", async () => {
    await ensureEngine();
    const rows = mixedRows();
    const want = show(decodeSst(await encodeSst(rows, "raw")));
    const packed = await encodeSst(rows, "lz4");
    const wasmDecoder = useLz4Decoder(lz4DecompressJs);
    expect(wasmDecoder).toBeDefined();
    try {
      expect(show(decodeSst(packed))).toEqual(want);
      expect(show([new SstReader(packed).get(key(5))])).toEqual(show([decodeSst(packed)[5]]));
    } finally {
      useLz4Decoder(wasmDecoder);
    }
  });

  it("read back an empty run", async () => {
    const packed = await encodeSst([], "lz4");
    expect(decodeSst(packed)).toEqual([]);
    expect(new SstReader(packed).range).toBeUndefined();
  });

  it("throw CorruptDatabaseError on a mangled block, with either decoder", async () => {
    const packed = await encodeSst(mixedRows(), "lz4");
    packed.fill(0xff, 4, 64);
    expect(() => new SstReader(packed).get(key(1))).toThrow(CorruptDatabaseError);
    const wasmDecoder = useLz4Decoder(lz4DecompressJs);
    try {
      expect(() => new SstReader(packed).get(key(1))).toThrow(CorruptDatabaseError);
    } finally {
      useLz4Decoder(wasmDecoder);
    }
  });
});

describe("compaction codec", () => {
  const todoRows = (from: number) =>
    Array.from({ length: 2_000 }, (_, i): SstEntry => ({
      kind: "put",
      key: key(from + i),
      value: enc.encode(`{"title":"todo ${(from + i) % 13}","done":false}`),
      seq: from + i + 1,
    }));

  async function stepFrom(path: string) {
    const fs = new MemoryFs();
    const body = await encodeSst(todoRows(0));
    await publishRun(fs, path, body);
    await publishGeneration(fs, { generation: 1, runs: [runMeta(path, body)], tombstoneSeq: 0 });
    const step = await mergeNextStep(fs);
    const out = step!.outputs[0]!;
    const bytes = (await fs.read(out.path, 0, Number.POSITIVE_INFINITY))!;
    return { out: out.path, bytes, raw: body };
  }

  const codecOf = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset).getUint32(b.byteLength - 16, true);

  it("writes LZ4 runs into L2", async () => {
    const { out, bytes, raw } = await stepFrom("l1/c1.0-50000000.sst");
    expect(out.startsWith("l2/")).toBe(true);
    expect(codecOf(bytes)).toBe(1);
    expect(bytes.byteLength).toBeLessThan(raw.byteLength / 2);
    expect(show(decodeSst(bytes))).toEqual(show(decodeSst(raw)));
  });

  it("writes raw runs into L1", async () => {
    const fs = new MemoryFs();
    const runs = [];
    for (let i = 0; i < 4; i++) {
      const body = await encodeSst(todoRows(i * 2_000));
      const path = `l0/${i}.sst`;
      await publishRun(fs, path, body);
      runs.push(runMeta(path, body));
    }
    await publishGeneration(fs, { generation: 1, runs, tombstoneSeq: 0 });
    const step = await mergeNextStep(fs);
    const out = step!.outputs[0]!;
    const bytes = (await fs.read(out.path, 0, Number.POSITIVE_INFINITY))!;
    expect(out.path.startsWith("l1/")).toBe(true);
    expect(codecOf(bytes)).toBe(0);
  });
});

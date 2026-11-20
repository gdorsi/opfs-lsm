import { describe, expect, it, vi } from "vitest";
import {
  EngineOutOfMemoryError,
  encodeRun,
  ensureEngine,
  flatEngine,
  lz4DecompressIn,
  scanBlockContainsIn,
} from "../src/store/engine.js";
import { CorruptDatabaseError } from "../src/errors.js";
import { crc32 } from "../src/store/crc32.js";
import type { EncodedRun, SstEntry } from "../src/store/sst.js";
import { decodeSst, encodeRunRef as encodeRunTs, sstKeyRange } from "./oracle/sst-ref.js";
import { mergeRuns, readerOfBytes, runGet } from "./runs.js";

const enc = new TextEncoder();
const utf = (s: string) => enc.encode(s);

describe("engine WASM", () => {
  it("loads wasm and round-trips SST", async () => {
    await ensureEngine();
    const body = (await encodeRun([
      { kind: "put", key: utf("a"), value: utf("1") },
      { kind: "del", key: utf("b") },
    ])).body;
    const entries = decodeSst(body);
    expect(entries).toHaveLength(2);
    // Sorted by key: "a" put, then "b" del
    expect(entries[0]!.kind).toBe("put");
    expect(new TextDecoder().decode(entries[0]!.key)).toBe("a");
    expect(entries[1]!.kind).toBe("del");
  });

  it("merges into a run whose Bloom filter is over 64 KiB", async () => {
    await ensureEngine();
    const half = (from: number) =>
      encodeRun(
        Array.from({ length: 30_000 }, (_, i) => ({
          kind: "put" as const,
          key: utf(`k${String(from + i).padStart(8, "0")}`),
          value: utf("v"),
        })),
      ).then((run) => run.body);
    const { runs } = await mergeRuns([[await half(0)], [await half(30_000)]]);
    expect(runs).toHaveLength(1);
    expect(decodeSst(runs[0]!.body)).toHaveLength(60_000);
    const reader = readerOfBytes(runs[0]!.body);
    expect((await runGet(reader, utf("k00059999")))?.kind).toBe("put");
  });

  it("cuts merge output into runs of about the target size, in key order", async () => {
    await ensureEngine();
    const body = (await encodeRun(
      Array.from({ length: 1000 }, (_, i) => ({
        kind: "put" as const,
        key: utf(`k${String(i).padStart(4, "0")}`),
        value: new Uint8Array(100),
      })),
    )).body;
    const { runs } = await mergeRuns([[body]], { targetBytes: 16 * 1024 });
    expect(runs.length).toBeGreaterThan(5);
    const keys = runs.flatMap((r) => decodeSst(r.body)).map((e) => new TextDecoder().decode(e.key));
    expect(keys).toEqual(Array.from({ length: 1000 }, (_, i) => `k${String(i).padStart(4, "0")}`));
    for (const r of runs.slice(0, -1)) expect(r.body.byteLength).toBeLessThan(20 * 1024);
    for (const r of runs) expectReportMatchesFile(r);
  });
});

/** What an encoder reports at the end of a run is what the file says. */
function expectReportMatchesFile(run: EncodedRun): void {
  expect(run.end.bytes).toBe(run.body.byteLength);
  expect(run.end.range).toEqual(sstKeyRange(run.body));
}

describe("the end of a run", () => {
  const put = (key: string, value = "v", seq = 1): SstEntry => ({ kind: "put", key: utf(key), value: utf(value), seq });
  const del = (key: string, seq = 1): SstEntry => ({ kind: "del", key: utf(key), seq });
  const todo = (n: number): SstEntry[] => Array.from({ length: n }, (_, i) => put(`todo/${String(i).padStart(6, "0")}`, `{"title":"buy milk ${i % 7}"}`, i));
  const shapes: [string, SstEntry[]][] = [
    ["no entries", []],
    ["one empty key", [put("")]],
    ["tombstones only", [del("b", 2), del("a", 1)]],
    ["unsorted input", [put("m"), put("c"), del("x"), put("a")]],
    ["equal keys", [put("a", "1", 1), del("a", 2), put("b")]],
    ["many blocks", todo(2_000)],
    ["a long shared prefix", Array.from({ length: 300 }, (_, i) => put(`${"p".repeat(200)}${String(i).padStart(4, "0")}`))],
  ];

  it.each(shapes)("a run of %s reports the size and key range the file holds, from wasm and from TypeScript", async (_name, entries) => {
    await ensureEngine();
    for (const run of [await encodeRun(entries, "raw"), await encodeRun(entries, "lz4"), encodeRunTs(entries)]) {
      expectReportMatchesFile(run);
      expect(run.end.range === undefined).toBe(entries.length === 0);
    }
  });

  it.each(shapes)("a raw run of %s is the same bytes and the same end from wasm and from TypeScript, with each key's last entry", async (_name, entries) => {
    await ensureEngine();
    const wasm = await encodeRun(entries, "raw");
    // The engine keeps the last entry of a key; the reference writes what it is given.
    const last = new Map(entries.map((e) => [e.key.join(), e]));
    const ts = encodeRunTs(entries.filter((e) => last.get(e.key.join()) === e));
    expect(wasm.end).toEqual(ts.end);
    expect(wasm.body).toEqual(ts.body);
  });

  it("is keys of their own, not views of the bytes the call returned", async () => {
    await ensureEngine();
    const run = await encodeRun([put("alpha"), put("omega")], "raw");
    const { smallest, largest } = run.end.range!;
    expect(smallest.buffer).not.toBe(run.body.buffer);
    expect(largest.buffer).not.toBe(run.body.buffer);
    expect(new TextDecoder().decode(smallest)).toBe("alpha");
    expect(new TextDecoder().decode(largest)).toBe("omega");
  });
});

describe("a run whose keys are out of order", () => {
  /** The run `[a, b]` with its two keys swapped in the data block and the CRC fixed, so it decodes as `[b, a]`. */
  function misordered(): Uint8Array {
    const sst = encodeRunTs([
      { kind: "put", key: utf("a"), value: utf("1"), seq: 1 },
      { kind: "put", key: utf("b"), value: utf("2"), seq: 2 },
    ]).body.slice();
    const [a, b] = [sst.indexOf(0x61), sst.indexOf(0x62)];
    sst[a] = 0x62;
    sst[b] = 0x61;
    const crcAt = sst.byteLength - 12;
    new DataView(sst.buffer).setUint32(crcAt, crc32(sst.subarray(0, crcAt)), true);
    return sst;
  }

  it("is refused by the wasm merge, in one output run and when a cut falls between the two keys", async () => {
    await ensureEngine();
    const sst = misordered();
    expect(decodeSst(sst).map((e) => new TextDecoder().decode(e.key))).toEqual(["b", "a"]);
    await expect(mergeRuns([[sst]])).rejects.toThrow(CorruptDatabaseError);
    // A target of 1 byte cuts after every entry, so each key opens an output run of its own.
    await expect(mergeRuns([[sst]], { targetBytes: 1 })).rejects.toThrow("keys out of order");
  });
});

describe("engine bridge", () => {
  it("keeps an encoded run valid after later calls", async () => {
    await ensureEngine();
    const run = (await encodeRun([
      { kind: "put", key: utf("alpha"), value: utf("one"), seq: 7 },
      { kind: "del", key: utf("beta"), seq: 2 ** 33 + 5 },
    ])).body;
    await encodeRun(
      Array.from({ length: 5000 }, (_, i) => ({
        kind: "put" as const,
        key: utf(`z${String(i).padStart(6, "0")}`),
        value: new Uint8Array(200).fill(0xee),
      })),
    );
    const first = decodeSst(run);
    const text = (b: Uint8Array) => new TextDecoder().decode(b);
    expect(text(first[0]!.key)).toBe("alpha");
    expect(first[0]!.kind === "put" && text(first[0]!.value)).toBe("one");
    expect(first[0]!.seq).toBe(7);
    expect(text(first[1]!.key)).toBe("beta");
    expect(first[1]!.seq).toBe(2 ** 33 + 5);
  });
});

describe("engine status codes", () => {
  /** A module whose every operation returns `code`. */
  const stub = (code: number): WebAssembly.Instance => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const fail = () => code;
    return {
      exports: {
        memory,
        input_ptr: () => 8,
        result_ptr: () => 0,
        result_len: () => 0,
        encode_sst: fail,
        lz4_decompress: fail,
        scan_block_contains: fail,
        merge_open: fail,
      },
    } as unknown as WebAssembly.Instance;
  };

  it("turns a negative status into CorruptDatabaseError", () => {
    const engine = flatEngine(stub(-4));
    expect(() => lz4DecompressIn(engine, new Uint8Array(4), 8)).toThrow(CorruptDatabaseError);
    expect(() => scanBlockContainsIn(engine, new Uint8Array(4), false, new Uint8Array(0))).toThrow(CorruptDatabaseError);
  });

  it("turns -11 into an error naming the operation and input size", () => {
    const engine = flatEngine(stub(-11));
    const run = () => lz4DecompressIn(engine, new Uint8Array(40), 8);
    expect(run).toThrow(EngineOutOfMemoryError);
    expect(run).not.toThrow(CorruptDatabaseError);
    expect(run).toThrow(/lz4_decompress.*40 bytes/);
  });

  it("reports a refused input region as an out of memory error", () => {
    const instance = stub(0);
    (instance.exports as unknown as { input_ptr: () => number }).input_ptr = () => 0;
    expect(() => lz4DecompressIn(flatEngine(instance), new Uint8Array(40), 8)).toThrow(EngineOutOfMemoryError);
  });
});

describe("a context where the wasm module does not load", () => {
  it("rejects ensureEngine and openDb with StorageUnavailableError, and loads on a later try", async () => {
    vi.resetModules();
    const engine = await import("../src/store/engine.js");
    const { StorageUnavailableError } = await import("../src/errors.js");
    const { openHarnessDb } = await import("../src/testing.js");
    const { readFile } = await import("node:fs/promises");
    try {
      engine.readEngineWith(() => Promise.reject(new Error("no such engine")));
      await expect(engine.ensureEngine()).rejects.toBeInstanceOf(StorageUnavailableError);
      await expect(openHarnessDb({ name: "no-wasm", forceMemory: true })).rejects.toBeInstanceOf(
        StorageUnavailableError,
      );
    } finally {
      engine.readEngineWith((url) => readFile(url));
    }
    await engine.ensureEngine();
    const db = await openHarnessDb({ name: "no-wasm", forceMemory: true });
    await db.close();
    vi.resetModules();
  });
});

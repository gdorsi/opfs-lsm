import { describe, expect, it } from "vitest";
import {
  EngineCapacityError,
  decodeSst,
  encodeRun,
  encodeSst,
  engineUsingWasm,
  ensureEngine,
  flatEngine,
  mergeSsts,
} from "../src/store/engine.js";
import { CorruptDatabaseError } from "../src/errors.js";
import { settle } from "../src/store/cursor.js";
import { encodeRun as encodeRunTs, sstKeyRange, type EncodedRun, type SstEntry } from "../src/store/sst.js";
import { readerOfBytes } from "./runs.js";

const enc = new TextEncoder();
const utf = (s: string) => enc.encode(s);

describe("engine WASM", () => {
  it("loads wasm and round-trips SST", async () => {
    await ensureEngine();
    expect(engineUsingWasm()).toBe(true);
    const body = await encodeSst([
      { kind: "put", key: utf("a"), value: utf("1") },
      { kind: "del", key: utf("b") },
    ]);
    const entries = await decodeSst(body);
    expect(entries).toHaveLength(2);
    // Sorted by key: "a" put, then "b" del
    expect(entries[0]!.kind).toBe("put");
    expect(new TextDecoder().decode(entries[0]!.key)).toBe("a");
    expect(entries[1]!.kind).toBe("del");
  });

  it("merges into a run whose Bloom filter is over 64 KiB", async () => {
    await ensureEngine();
    const half = (from: number) =>
      encodeSst(
        Array.from({ length: 30_000 }, (_, i) => ({
          kind: "put" as const,
          key: utf(`k${String(from + i).padStart(8, "0")}`),
          value: utf("v"),
        })),
      );
    const { runs } = await mergeSsts([await half(0), await half(30_000)], false);
    expect(runs).toHaveLength(1);
    expect(await decodeSst(runs[0]!.body)).toHaveLength(60_000);
    const reader = readerOfBytes(runs[0]!.body);
    expect((await settle(() => reader.get(utf("k00059999"))))?.kind).toBe("put");
  });

  it("cuts merge output into runs of about the target size, in key order", async () => {
    await ensureEngine();
    const body = await encodeSst(
      Array.from({ length: 1000 }, (_, i) => ({
        kind: "put" as const,
        key: utf(`k${String(i).padStart(4, "0")}`),
        value: new Uint8Array(100),
      })),
    );
    const { runs } = await mergeSsts([body], false, 16 * 1024);
    expect(runs.length).toBeGreaterThan(5);
    const keys = (await Promise.all(runs.map((r) => decodeSst(r.body)))).flat().map((e) => new TextDecoder().decode(e.key));
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
    expect(engineUsingWasm()).toBe(true);
    for (const run of [await encodeRun(entries, "raw"), await encodeRun(entries, "lz4"), encodeRunTs(entries)]) {
      expectReportMatchesFile(run);
      expect(run.end.range === undefined).toBe(entries.length === 0);
    }
  });

  it.each(shapes)("a raw run of %s is the same bytes and the same end from wasm and from TypeScript", async (_name, entries) => {
    await ensureEngine();
    const wasm = await encodeRun(entries, "raw");
    const ts = encodeRunTs(entries);
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

describe("engine bridge", () => {
  it("keeps decoded entries valid after later calls", async () => {
    await ensureEngine();
    const first = await decodeSst(
      await encodeSst([
        { kind: "put", key: utf("alpha"), value: utf("one"), seq: 7 },
        { kind: "del", key: utf("beta"), seq: 2 ** 33 + 5 },
      ]),
    );
    const big = await encodeSst(
      Array.from({ length: 5000 }, (_, i) => ({
        kind: "put" as const,
        key: utf(`z${String(i).padStart(6, "0")}`),
        value: new Uint8Array(200).fill(0xee),
      })),
    );
    await decodeSst(big);
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
        init: () => 0,
        input_ptr: () => 8,
        result_ptr: () => 0,
        result_len: () => 0,
        encode_sst: fail,
        decode_sst: fail,
        lz4_decompress: fail,
        scan_block_contains: fail,
        merge_ssts: fail,
      },
    } as unknown as WebAssembly.Instance;
  };

  it("turns a negative status into CorruptDatabaseError", () => {
    const engine = flatEngine(stub(-4));
    expect(() => engine.decodeSst(new Uint8Array(4))).toThrow(CorruptDatabaseError);
    expect(() => engine.lz4Decompress(new Uint8Array(4), 8)).toThrow(CorruptDatabaseError);
  });

  it("turns -11 into an error naming the operation, input size and capacity", () => {
    const engine = flatEngine(stub(-11), 1234);
    const run = () => engine.decodeSst(new Uint8Array(40));
    expect(run).toThrow(EngineCapacityError);
    expect(run).not.toThrow(CorruptDatabaseError);
    expect(run).toThrow(/decode_sst.*40 bytes.*1234/);
  });

  it("reports a refused input region as a capacity error", () => {
    const instance = stub(0);
    (instance.exports as unknown as { input_ptr: () => number }).input_ptr = () => 0;
    expect(() => flatEngine(instance, 99).decodeSst(new Uint8Array(40))).toThrow(EngineCapacityError);
  });
});

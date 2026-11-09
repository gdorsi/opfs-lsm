import { describe, expect, it } from "vitest";
import {
  EngineCapacityError,
  decodeSst,
  encodeSst,
  engineUsingWasm,
  ensureEngine,
  flatEngine,
  mergeSsts,
} from "../src/store/engine.js";
import { CorruptDatabaseError } from "../src/errors.js";
import { settle } from "../src/store/cursor.js";
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
    const { ssts } = await mergeSsts([await half(0), await half(30_000)], false);
    expect(ssts).toHaveLength(1);
    expect(await decodeSst(ssts[0]!)).toHaveLength(60_000);
    const reader = readerOfBytes(ssts[0]!);
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
    const { ssts } = await mergeSsts([body], false, 16 * 1024);
    expect(ssts.length).toBeGreaterThan(5);
    const keys = (await Promise.all(ssts.map((s) => decodeSst(s)))).flat().map((e) => new TextDecoder().decode(e.key));
    expect(keys).toEqual(Array.from({ length: 1000 }, (_, i) => `k${String(i).padStart(4, "0")}`));
    for (const s of ssts.slice(0, -1)) expect(s.byteLength).toBeLessThan(20 * 1024);
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

import { describe, expect, it } from "vitest";
import {
  decodeSst,
  encodeSst,
  engineUsingWasm,
  ensureEngine,
  mergeSsts,
} from "../src/store/engine.js";
import { SstReader } from "../src/store/sst.js";

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
    expect(new SstReader(ssts[0]!).get(utf("k00059999"))?.kind).toBe("put");
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

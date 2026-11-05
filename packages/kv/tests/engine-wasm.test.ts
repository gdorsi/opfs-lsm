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
    const { sst } = await mergeSsts([await half(0), await half(30_000)], false);
    expect(await decodeSst(sst)).toHaveLength(60_000);
    expect(new SstReader(sst).get(utf("k00059999"))?.kind).toBe("put");
  });
});

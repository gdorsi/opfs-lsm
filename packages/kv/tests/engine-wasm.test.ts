import { describe, expect, it } from "vitest";
import {
  decodeSst,
  encodeSst,
  engineUsingWasm,
  ensureEngine,
} from "../src/store/engine.js";

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
});


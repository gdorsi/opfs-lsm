import { describe, expect, it } from "vitest";
import { CorruptDatabaseError } from "../src/errors.js";
import {
  decodeSst,
  encodeSst,
  SstReader,
  SST_BLOCK_TARGET,
} from "../src/store/sst.js";
import { SstLayer } from "../src/store/sst-layer.js";

const enc = new TextEncoder();
const utf = (s: string) => enc.encode(s);

describe("sst v2", () => {
  it("round-trips puts and deletes", () => {
    const body = encodeSst([
      { kind: "put", key: utf("b"), value: utf("2") },
      { kind: "del", key: utf("a") },
      { kind: "put", key: utf("c"), value: utf("3") },
    ]);
    const entries = decodeSst(body);
    expect(entries.map((e) => e.kind + ":" + new TextDecoder().decode(e.key))).toEqual([
      "del:a",
      "put:b",
      "put:c",
    ]);
  });

  it("rejects corrupt crc", () => {
    const body = encodeSst([{ kind: "put", key: utf("a"), value: utf("1") }]);
    body[body.byteLength - 1] ^= 0xff;
    expect(() => decodeSst(body)).toThrow(CorruptDatabaseError);
  });

  it("splits into multiple blocks", () => {
    const entries = Array.from({ length: 200 }, (_, i) => ({
      kind: "put" as const,
      key: utf(`k${String(i).padStart(4, "0")}`),
      value: utf(`v${i}`),
    }));
    const body = encodeSst(entries, 256);
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    expect(view.getUint32(4, true)).toBe(2); // version
    expect(view.getUint32(12, true)).toBeGreaterThan(1); // blockCount
    expect(decodeSst(body)).toHaveLength(200);
  });

  it("SstReader point-gets via bloom + one block", () => {
    const entries = Array.from({ length: 80 }, (_, i) => ({
      kind: "put" as const,
      key: utf(`k${String(i).padStart(3, "0")}`),
      value: utf(`v${i}`),
    }));
    const body = encodeSst(entries, 200);
    const reader = new SstReader(body);
    expect(reader.mightContain(utf("k040"))).toBe(true);
    expect(reader.get(utf("k040"))).toEqual({
      kind: "put",
      key: utf("k040"),
      value: utf("v40"),
    });
    expect(reader.get(utf("missing"))).toBeUndefined();
  });

  it("SstLayer newest-first wins", () => {
    const older = encodeSst([
      { kind: "put", key: utf("a"), value: utf("old") },
      { kind: "put", key: utf("b"), value: utf("1") },
    ]);
    const newer = encodeSst([
      { kind: "put", key: utf("a"), value: utf("new") },
      { kind: "del", key: utf("b") },
    ]);
    const layer = SstLayer.fromBlobs([newer, older]);
    expect(layer.get(utf("a"))).toEqual({
      status: "value",
      value: utf("new"),
    });
    expect(layer.get(utf("b"))).toEqual({ status: "tomb" });
    expect(layer.get(utf("c"))).toEqual({ status: "miss" });
  });

  it("default block target constant is 4KiB", () => {
    expect(SST_BLOCK_TARGET).toBe(4096);
  });
});

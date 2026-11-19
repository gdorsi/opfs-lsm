import { describe, expect, it } from "vitest";
import { bloomMightContain } from "../src/store/bloom.js";
import { bloomAdd, createBloom } from "./oracle/sst-ref.js";

const enc = new TextEncoder();

describe("bloom", () => {
  it("always hits inserted keys and usually misses others", () => {
    const filter = createBloom(100);
    for (let i = 0; i < 50; i++) {
      bloomAdd(filter, enc.encode(`k${i}`));
    }
    for (let i = 0; i < 50; i++) {
      expect(bloomMightContain(filter, enc.encode(`k${i}`))).toBe(true);
    }
    let falsePos = 0;
    for (let i = 0; i < 200; i++) {
      if (bloomMightContain(filter, enc.encode(`miss${i}`))) falsePos++;
    }
    expect(falsePos).toBeLessThan(40);
  });

  it("probes the bits the encoder set, for every size and hash count a run can have", () => {
    for (const bytes of [1, 8, 125, 4_099, 200_000]) {
      for (const hashCount of [1, 7, 32]) {
        const filter = { bits: new Uint8Array(bytes), hashCount };
        const keys = Array.from({ length: 2_000 }, (_, i) => enc.encode(`key/${bytes}/${i}`));
        for (const key of keys) bloomAdd(filter, key);
        const missed = keys.filter((key) => !bloomMightContain(filter, key)).length;
        expect(`${bytes} bytes, ${hashCount} hashes: ${missed} missed`).toBe(`${bytes} bytes, ${hashCount} hashes: 0 missed`);
      }
    }
  });

  it("holds no key when it has no bits", () => {
    expect(bloomMightContain({ bits: new Uint8Array(0), hashCount: 7 }, enc.encode("k"))).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  bloomAdd,
  bloomMightContain,
  createBloom,
} from "../src/store/bloom.js";

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
});

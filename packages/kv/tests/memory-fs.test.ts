import { describe, expect, it } from "vitest";
import { MemoryFs } from "../src/testing.js";

describe("MemoryFs publish-on-finish", () => {
  it("keeps stages invisible until finish", async () => {
    const fs = new MemoryFs();
    const w = await fs.create("l0/a.sst");
    await w.write(new TextEncoder().encode("hello"));
    expect(await fs.read("l0/a.sst", 0, 10)).toBeUndefined();
    await w.finish();
    const got = await fs.read("l0/a.sst", 0, 10);
    expect(got && new TextDecoder().decode(got)).toBe("hello");
  });

  it("abort drops the stage", async () => {
    const fs = new MemoryFs();
    const w = await fs.create("l0/b.sst");
    await w.write(new TextEncoder().encode("x"));
    await w.abort();
    expect(await fs.read("l0/b.sst", 0, 10)).toBeUndefined();
  });
});

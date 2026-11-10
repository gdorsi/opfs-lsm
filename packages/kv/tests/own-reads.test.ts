import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryFs } from "../src/index.js";
import { openHarnessDb, __resetMemoryFsForTests } from "../src/testing.js";

const NAME = "own-reads-test";
const enc = new TextEncoder();
const dec = new TextDecoder();

beforeEach(() => __resetMemoryFsForTests(NAME));
afterEach(() => __resetMemoryFsForTests(NAME));

describe("this page's writes over the installed runs", () => {
  it("serves repeated gets without losing visibility", async () => {
    const db = await openHarnessDb({ name: NAME, forceMemory: true });
    await db.put(enc.encode("a"), enc.encode("1"));
    expect(dec.decode(await db.get(enc.encode("a")))).toBe("1");
    expect(dec.decode(await db.get(enc.encode("a")))).toBe("1");
    await db.put(enc.encode("a"), enc.encode("2"));
    expect(dec.decode(await db.get(enc.encode("a")))).toBe("2");
    await db.close();
  });

  it("drops a write once the installed runs hold it, and the runs serve it", async () => {
    const db = await openHarnessDb({ name: NAME, forceMemory: true });
    await db.put(enc.encode("k"), enc.encode("v"));
    await db.ingest();
    expect(dec.decode(await db.get(enc.encode("k")))).toBe("v");
    await db.close();
  });

  it("reads another page's key from a manifest installed after its SST readers were warmed", async () => {
    const fs = new MemoryFs();
    const a = await openHarnessDb({ name: NAME, fs });
    const b = await openHarnessDb({ name: NAME, fs });

    await a.put(enc.encode("seed"), enc.encode("s"));
    await a.ingest();
    expect(dec.decode((await a.get(enc.encode("seed")))!)).toBe("s");

    await b.put(enc.encode("k"), enc.encode("v"));
    await b.sync();
    await a.sync();

    const got = await a.get(enc.encode("k"));
    expect(got && dec.decode(got)).toBe("v");
    await a.close();
    await b.close();
  });
});

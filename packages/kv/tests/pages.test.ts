import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryFs, type ChangeEvent } from "../src/index.js";
import { openHarnessDb, __resetMemoryFsForTests } from "../src/testing.js";

const NAME = "pages-test";
const enc = new TextEncoder();
const dec = new TextDecoder();
const utf = (s: string) => enc.encode(s);
const text = (v: Uint8Array | undefined) => (v ? dec.decode(v) : undefined);

beforeEach(() => __resetMemoryFsForTests(NAME));
afterEach(() => __resetMemoryFsForTests(NAME));

describe("pages of one database", () => {
  it("a page reads its own write at the ack, and another page's only once installed", async () => {
    const fs = new MemoryFs();
    const one = await openHarnessDb({ name: NAME, fs });
    const two = await openHarnessDb({ name: NAME, fs });
    await one.put(utf("first"), utf("1"));
    await two.put(utf("second"), utf("2"));
    expect(text(await two.get(utf("second")))).toBe("2");
    expect(text(await two.get(utf("first"))), "one's write is not ingested yet").toBeUndefined();
    await two.sync();
    expect(text(await two.get(utf("first"))), "sync asks one to flush").toBe("1");
    await one.close();
    await two.close();
  });

  it("a page opened after another's ack reads it: open waits for the other pages' flush", async () => {
    const fs = new MemoryFs();
    const a = await openHarnessDb({ name: NAME, fs });
    await a.put(utf("a"), utf("from-a"));
    const b = await openHarnessDb({ name: NAME, fs });
    expect(text(await b.get(utf("a")))).toBe("from-a");
    await a.close();
    await b.close();
  });

  it("after both sync, both pages read the write ingested last", async () => {
    const fs = new MemoryFs();
    const a = await openHarnessDb({ name: NAME, fs });
    const b = await openHarnessDb({ name: NAME, fs });
    await a.put(utf("k"), utf("a"));
    await b.put(utf("k"), utf("b"));
    expect(text(await a.get(utf("k")))).toBe("a");
    expect(text(await b.get(utf("k")))).toBe("b");
    await a.sync();
    await b.sync();
    const winner = text(await a.get(utf("k")));
    expect(["a", "b"]).toContain(winner);
    expect(text(await b.get(utf("k")))).toBe(winner);
    await a.close();
    await b.close();
  });

  it("another page's write arrives without sync, as an install", async () => {
    const fs = new MemoryFs();
    const a = await openHarnessDb({ name: NAME, fs });
    const b = await openHarnessDb({ name: NAME, fs });
    const arrived = new Promise<void>((resolve) => {
      a.changes((ev: ChangeEvent) => {
        if (ev.kind === "ingest") resolve();
      });
    });
    await b.put(utf("k"), utf("b"));
    await arrived;
    expect(text(await a.get(utf("k")))).toBe("b");
    await a.close();
    await b.close();
  });

  it("a page that closes right after its writes loses none of them", async () => {
    const fs = new MemoryFs();
    const a = await openHarnessDb({ name: NAME, fs });
    const writes = Array.from({ length: 50 }, (_, i) => a.put(utf(`k${i}`), utf(`${i}`)));
    await Promise.all(writes);
    await a.close();
    const b = await openHarnessDb({ name: NAME, fs });
    for (let i = 0; i < 50; i++) expect(text(await b.get(utf(`k${i}`)))).toBe(`${i}`);
    await b.close();
  });

  it("a write past pendingBytes waits for an ingest, and the order of writes holds", async () => {
    const fs = new MemoryFs();
    const db = await openHarnessDb({ name: NAME, fs, pendingBytes: 1 << 20 });
    const big = new Uint8Array(400 * 1024);
    const writes = Array.from({ length: 8 }, (_, i) => db.put(utf("k"), big.slice().fill(i)));
    await Promise.all(writes);
    expect((await db.get(utf("k")))?.[0]).toBe(7);
    await db.sync();
    expect((await db.get(utf("k")))?.[0]).toBe(7);
    await db.close();
  });
});

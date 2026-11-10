import { afterEach, describe, expect, it } from "vitest";
import { prefixBound } from "../src/index.js";
import { openHarnessDb, __resetMemoryFsForTests } from "../src/testing.js";
import { MemoryFs } from "../src/opfs/memory-fs.js";

const enc = new TextEncoder();
const utf = (s: string) => enc.encode(s);

afterEach(() => {
  __resetMemoryFsForTests("notes");
  __resetMemoryFsForTests("notes2");
});

describe("ingest", () => {
  it("after ingest, the value is readable from the runs by another page", async () => {
    const fs = new MemoryFs();
    const a = await openHarnessDb({ name: "notes", fs });
    await a.put(utf("a"), utf("from-a"));
    const { generation } = await a.ingest();
    expect(generation).toBe(1);

    const b = await openHarnessDb({ name: "notes", fs });
    const v = await b.get(utf("a"));
    expect(v && new TextDecoder().decode(v)).toBe("from-a");
    await a.close();
    await b.close();
  });

  it("an ingest with nothing new publishes no generation", async () => {
    const fs = new MemoryFs();
    const a = await openHarnessDb({ name: "notes", fs });
    await a.put(utf("k"), utf("v"));
    expect((await a.ingest()).generation).toBe(1);
    expect((await a.ingest()).generation).toBe(1);
    await a.close();
  });

  it("the writing page still reads its write once the runs hold it", async () => {
    const fs = new MemoryFs();
    const a = await openHarnessDb({ name: "notes", fs });
    await a.put(utf("a"), utf("1"));
    await a.ingest();
    const v = await a.get(utf("a"));
    expect(v && new TextDecoder().decode(v)).toBe("1");
    await a.close();
  });
});

describe("batch + prefixBound", () => {
  it("a batch is one record, read back in key order", async () => {
    const db = await openHarnessDb({ name: "notes2" });
    await db.batch((tx) => {
      tx.put(utf("note/1"), utf("x"));
      tx.put(utf("note/2"), utf("y"));
    });
    const keys: string[] = [];
    for await (const e of db.range(prefixBound(utf("note/")))) {
      keys.push(new TextDecoder().decode(e.key));
    }
    expect(keys).toEqual(["note/1", "note/2"]);
    await db.close();
  });

  it("range reads one state while writes and an ingest land mid-scan", async () => {
    const db = await openHarnessDb({ name: "notes2" });
    await db.batch((tx) => {
      tx.put(utf("note/1"), utf("x"));
      tx.put(utf("note/3"), utf("z"));
    });
    await db.ingest();
    await db.put(utf("note/2"), utf("y"));
    const seen: string[] = [];
    for await (const e of db.range(prefixBound(utf("note/")))) {
      seen.push(`${new TextDecoder().decode(e.key)}=${new TextDecoder().decode(e.value)}`);
      if (seen.length === 1) {
        await db.put(utf("note/1b"), utf("new"));
        await db.delete(utf("note/3"));
        await db.ingest();
      }
    }
    expect(seen).toEqual(["note/1=x", "note/2=y", "note/3=z"]);
    await db.close();
  });
});

describe("ingest", () => {
  it("70 MiB of writes, more than pendingBytes and many L0 runs, stays readable from another page", async () => {
    const fs = new MemoryFs();
    const a = await openHarnessDb({ name: "notes", fs });
    const value = (i: number) => new Uint8Array(1 << 20).fill(i);
    for (let i = 0; i < 70; i++) await a.put(utf(`k${String(i).padStart(2, "0")}`), value(i));
    await a.ingest();
    const b = await openHarnessDb({ name: "notes", fs });
    for (let i = 0; i < 70; i++) {
      expect((await b.get(utf(`k${String(i).padStart(2, "0")}`)))?.[0]).toBe(i);
    }
    await a.close();
    await b.close();
    // About 35 ingests of 2 MiB and the compactions they start: 4 s alone, slower beside the other files.
  }, 30_000);
});

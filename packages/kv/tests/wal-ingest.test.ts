import { afterEach, describe, expect, it } from "vitest";
import {
  prefixBound
} from "../src/index.js";
import {
  openHarnessDb,
  __resetMemoryFsForTests,
  ingest,
} from "../src/testing.js";
import { MemoryFs } from "../src/opfs/memory-fs.js";

const enc = new TextEncoder();
const utf = (s: string) => enc.encode(s);

async function deleteIdb(name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${name}`);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

afterEach(async () => {
  await deleteIdb("notes");
  await deleteIdb("notes2");
  __resetMemoryFsForTests("notes");
  __resetMemoryFsForTests("notes2");
});

describe("shared IDB WAL", () => {
  it("put resolves after IDB commit and get sees the row", async () => {
    const db = await openHarnessDb({ name: "notes", writerId: "w1", forceMemory: true });
    await db.put(utf("a"), utf("1"));
    const v = await db.get(utf("a"));
    expect(v && new TextDecoder().decode(v)).toBe("1");
    await db.close();
  });

  it("other tab sees acked WAL without ingest", async () => {
    const fs = new MemoryFs();
    const a = await openHarnessDb({ name: "notes", writerId: "w1", fs });
    await a.put(utf("a"), utf("from-a"));
    const b = await openHarnessDb({ name: "notes", writerId: "w2", fs });
    const v = await b.get(utf("a"));
    expect(v && new TextDecoder().decode(v)).toBe("from-a");
    await a.close();
    await b.close();
  });

  it("later WAL seq wins across writers", async () => {
    const fs = new MemoryFs();
    const a = await openHarnessDb({ name: "notes", writerId: "w1", fs });
    const b = await openHarnessDb({ name: "notes", writerId: "w2", fs });
    await a.put(utf("k"), utf("a"));
    await b.put(utf("k"), utf("b"));
    await a.sync();
    expect(new TextDecoder().decode((await a.get(utf("k")))!)).toBe("b");
    await a.close();
    await b.close();
  });

  it("another tab's write arrives without sync", async () => {
    const fs = new MemoryFs();
    const a = await openHarnessDb({ name: "notes", writerId: "w1", fs });
    const b = await openHarnessDb({ name: "notes", writerId: "w2", fs });
    const arrived = new Promise<void>((resolve) => {
      a.changes((ev) => {
        if (ev.kind === "append") resolve();
      });
    });
    await b.put(utf("k"), utf("b"));
    await arrived;
    expect(new TextDecoder().decode((await a.get(utf("k")))!)).toBe("b");
    await a.close();
    await b.close();
  });
});

describe("ingest", () => {
  it("after ingest, value still readable via SST once WAL truncated", async () => {
    const fs = new MemoryFs();
    const a = await openHarnessDb({ name: "notes", writerId: "w1", fs });
    await a.put(utf("a"), utf("from-a"));
    const { generation } = await ingest(a);
    expect(generation).toBe(1);

    const b = await openHarnessDb({ name: "notes", writerId: "w2", fs });
    const v = await b.get(utf("a"));
    expect(v && new TextDecoder().decode(v)).toBe("from-a");
    await a.close();
    await b.close();
  });

  it("reingest of empty WAL does not bump generation", async () => {
    const fs = new MemoryFs();
    const a = await openHarnessDb({ name: "notes", writerId: "w1", fs });
    await a.put(utf("k"), utf("v"));
    expect((await ingest(a)).generation).toBe(1);
    expect((await ingest(a)).generation).toBe(1);
    await a.close();
  });

  it("same writer still reads after WAL truncated by ingest", async () => {
    const fs = new MemoryFs();
    const a = await openHarnessDb({ name: "notes", writerId: "w1", fs });
    await a.put(utf("a"), utf("1"));
    await ingest(a);
    const v = await a.get(utf("a"));
    expect(v && new TextDecoder().decode(v)).toBe("1");
    await a.close();
  });
});

describe("batch + prefixBound", () => {
  it("batch is one IDB append", async () => {
    const db = await openHarnessDb({ name: "notes2", writerId: "w1", forceMemory: true });
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
    const db = await openHarnessDb({ name: "notes2", writerId: "w1", forceMemory: true });
    await db.batch((tx) => {
      tx.put(utf("note/1"), utf("x"));
      tx.put(utf("note/3"), utf("z"));
    });
    await ingest(db);
    await db.put(utf("note/2"), utf("y"));
    const seen: string[] = [];
    for await (const e of db.range(prefixBound(utf("note/")))) {
      seen.push(`${new TextDecoder().decode(e.key)}=${new TextDecoder().decode(e.value)}`);
      if (seen.length === 1) {
        await db.put(utf("note/1b"), utf("new"));
        await db.delete(utf("note/3"));
        await ingest(db);
      }
    }
    expect(seen).toEqual(["note/1=x", "note/2=y", "note/3=z"]);
    await db.close();
  });
});

describe("ingest", () => {
  it("a flush larger than one run stays readable from another tab", async () => {
    const fs = new MemoryFs();
    const policy = { maxWalBytes: 2 ** 40 };
    const a = await openHarnessDb({ name: "notes", writerId: "w1", fs, ingestPolicy: policy });
    const value = (i: number) => new Uint8Array(1 << 20).fill(i);
    for (let i = 0; i < 70; i++) await a.put(utf(`k${String(i).padStart(2, "0")}`), value(i));
    await ingest(a);
    const b = await openHarnessDb({ name: "notes", writerId: "w2", fs, ingestPolicy: policy });
    for (let i = 0; i < 70; i++) {
      expect((await b.get(utf(`k${String(i).padStart(2, "0")}`)))?.[0]).toBe(i);
    }
    await a.close();
    await b.close();
  });
});

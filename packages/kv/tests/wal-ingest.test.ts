import { afterEach, describe, expect, it } from "vitest";
import {
  __resetMemoryFsForTests,
  openDb,
  prefixBound,
} from "../src/index.js";
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
    const db = await openDb({ name: "notes", writerId: "w1" });
    await db.put(utf("a"), utf("1"));
    const v = await db.get(utf("a"));
    expect(v && new TextDecoder().decode(v)).toBe("1");
    await db.close();
  });

  it("other tab sees acked WAL without ingest", async () => {
    const fs = new MemoryFs();
    const a = await openDb({ name: "notes", writerId: "w1", fs });
    await a.put(utf("a"), utf("from-a"));
    const b = await openDb({ name: "notes", writerId: "w2", fs });
    const v = await b.get(utf("a"));
    expect(v && new TextDecoder().decode(v)).toBe("from-a");
    await a.close();
    await b.close();
  });

  it("later WAL seq wins across writers", async () => {
    const fs = new MemoryFs();
    const a = await openDb({ name: "notes", writerId: "w1", fs });
    const b = await openDb({ name: "notes", writerId: "w2", fs });
    await a.put(utf("k"), utf("a"));
    await b.put(utf("k"), utf("b"));
    await a.sync();
    expect(new TextDecoder().decode((await a.get(utf("k")))!)).toBe("b");
    await a.close();
    await b.close();
  });

  it("another tab's write arrives without sync", async () => {
    const fs = new MemoryFs();
    const a = await openDb({ name: "notes", writerId: "w1", fs });
    const b = await openDb({ name: "notes", writerId: "w2", fs });
    const arrived = new Promise<void>((resolve) => {
      a.changes((ev) => {
        if (ev.writerId === "w2") resolve();
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
    const a = await openDb({ name: "notes", writerId: "w1", fs });
    await a.put(utf("a"), utf("from-a"));
    const { generation } = await a.ingest();
    expect(generation).toBe(1);

    const b = await openDb({ name: "notes", writerId: "w2", fs });
    const v = await b.get(utf("a"));
    expect(v && new TextDecoder().decode(v)).toBe("from-a");
    await a.close();
    await b.close();
  });

  it("reingest of empty WAL does not bump generation", async () => {
    const fs = new MemoryFs();
    const a = await openDb({ name: "notes", writerId: "w1", fs });
    await a.put(utf("k"), utf("v"));
    expect((await a.ingest()).generation).toBe(1);
    expect((await a.ingest()).generation).toBe(1);
    await a.close();
  });

  it("same writer still reads after WAL truncated by ingest", async () => {
    const fs = new MemoryFs();
    const a = await openDb({ name: "notes", writerId: "w1", fs });
    await a.put(utf("a"), utf("1"));
    await a.ingest();
    const v = await a.get(utf("a"));
    expect(v && new TextDecoder().decode(v)).toBe("1");
    await a.close();
  });
});

describe("batch + prefixBound", () => {
  it("batch is one IDB append", async () => {
    const db = await openDb({ name: "notes2", writerId: "w1" });
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
    const db = await openDb({ name: "notes2", writerId: "w1" });
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

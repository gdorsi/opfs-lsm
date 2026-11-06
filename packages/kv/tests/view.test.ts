import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  openHarnessDb,
  __resetMemoryFsForTests
} from "../src/testing.js";

const NAME = "view-test";
const enc = new TextEncoder();
const dec = new TextDecoder();

function wipe(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${NAME}`);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  __resetMemoryFsForTests(NAME);
  await wipe();
});

afterEach(() => {
  __resetMemoryFsForTests(NAME);
});

describe("view snapshot", () => {
  it("pins WAL head so later puts are invisible", async () => {
    const db = await openHarnessDb({
      name: NAME,
      forceMemory: true,
      writerId: "w1",
      ingestPolicy: { maxWalBytes: 1 << 30 },
    });
    await db.put(enc.encode("a"), enc.encode("1"));

    const seen = await db.view(async (snap) => {
      await db.put(enc.encode("a"), enc.encode("2"));
      await db.put(enc.encode("b"), enc.encode("x"));
      const a = await snap.get(enc.encode("a"));
      const b = await snap.get(enc.encode("b"));
      return {
        a: a ? dec.decode(a) : undefined,
        b: b ? dec.decode(b) : undefined,
        head: snap.walHead,
      };
    });

    expect(seen.a).toBe("1");
    expect(seen.b).toBeUndefined();
    expect(dec.decode((await db.get(enc.encode("a")))!)).toBe("2");
    await db.close();
  });

  it("closes snapshot after callback", async () => {
    const db = await openHarnessDb({
      name: NAME,
      forceMemory: true,
      writerId: "w1",
      ingestPolicy: { maxWalBytes: 1 << 30 },
    });
    let leaked: { get(key: Uint8Array): Promise<Uint8Array | undefined> } | undefined;
    await db.view(async (snap) => {
      leaked = snap;
      return null;
    });
    await expect(leaked!.get(enc.encode("a"))).rejects.toThrow(/closed/);
    await db.close();
  });

  it("keeps its rows while later writes split the memtable", async () => {
    const db = await openHarnessDb({
      name: NAME,
      forceMemory: true,
      writerId: "w1",
      ingestPolicy: { maxWalBytes: 1 << 30 },
    });
    const key = (i: number) => enc.encode(`k${String(i).padStart(5, "0")}`);
    await db.batch((tx) => {
      for (let i = 0; i < 3000; i += 2) tx.put(key(i), enc.encode("old"));
    });
    const seen = await db.view(async (snap) => {
      await db.batch((tx) => {
        for (let i = 0; i < 3000; i++) tx.put(key(i), enc.encode("new"));
      });
      const rows: string[] = [];
      for await (const e of snap.range({ start: key(1000), endExclusive: key(1010) })) {
        rows.push(`${dec.decode(e.key)}=${dec.decode(e.value)}`);
      }
      return { rows, odd: await snap.get(key(1001)), even: await snap.get(key(2998)) };
    });
    expect(seen.rows).toEqual(
      [1000, 1002, 1004, 1006, 1008].map((i) => `k${String(i).padStart(5, "0")}=old`),
    );
    expect(seen.odd).toBeUndefined();
    expect(dec.decode(seen.even!)).toBe("old");
    expect(dec.decode((await db.get(key(1001)))!)).toBe("new");
    await db.close();
  });
});

describe("range with valueContains", () => {
  async function seeded() {
    const db = await openHarnessDb({
      name: NAME,
      forceMemory: true,
      writerId: "w1",
      ingestPolicy: { maxWalBytes: 1 << 30 },
    });
    await db.put(enc.encode("a"), enc.encode(" red apple"));
    await db.put(enc.encode("b"), enc.encode(" red pear"));
    await db.put(enc.encode("c"), enc.encode(" red plum"));
    await db.put(enc.encode("e"), enc.encode(" red fig"));
    await db.put(enc.encode("f"), enc.encode(" blue"));
    await db.ingest();
    await db.put(enc.encode("b"), enc.encode(" green pear"));
    await db.delete(enc.encode("c"));
    await db.put(enc.encode("d"), enc.encode(" red kiwi"));
    await db.put(enc.encode("e"), enc.encode(" red fig ripe"));
    return db;
  }
  const red = [enc.encode(" red")];
  const pairs = async (rows: AsyncIterable<{ key: Uint8Array; value: Uint8Array }>) => {
    const out: string[] = [];
    for await (const r of rows) out.push(`${dec.decode(r.key)}=${dec.decode(r.value)}`);
    return out;
  };

  it("yields each matching key once with its current value, in key order", async () => {
    const db = await seeded();
    const want = ["a= red apple", "d= red kiwi", "e= red fig ripe"];
    expect(await pairs(db.range({ valueContains: red }))).toEqual(want);
    expect(await db.view((snap) => pairs(snap.range({ valueContains: red })))).toEqual(want);
    await db.close();
  });

  it("honours bounds, and limit counts matches", async () => {
    const db = await seeded();
    expect(await pairs(db.range({ start: enc.encode("b"), endExclusive: enc.encode("e"), valueContains: red }))).toEqual([
      "d= red kiwi",
    ]);
    expect(await pairs(db.range({ limit: 2, valueContains: red }))).toEqual(["a= red apple", "d= red kiwi"]);
    await db.close();
  });

  it("keeps only values that hold every pattern", async () => {
    const db = await seeded();
    expect(await pairs(db.range({ valueContains: [enc.encode(" red"), enc.encode(" fig")] }))).toEqual(["e= red fig ripe"]);
    await db.close();
  });

  it("sees the view's snapshot, not later writes", async () => {
    const db = await seeded();
    const got = await db.view(async (snap) => {
      await db.put(enc.encode("a"), enc.encode(" blue apple"));
      await db.put(enc.encode("g"), enc.encode(" red grape"));
      return pairs(snap.range({ valueContains: red }));
    });
    expect(got).toEqual(["a= red apple", "d= red kiwi", "e= red fig ripe"]);
    expect(await pairs(db.range({ valueContains: red }))).toEqual(["d= red kiwi", "e= red fig ripe", "g= red grape"]);
    await db.close();
  });

  it("closes with the snapshot", async () => {
    const db = await seeded();
    const snap = await db.view((s) => s);
    await expect(pairs(snap.range({ valueContains: red }))).rejects.toThrow(/closed/);
    await db.close();
  });
});

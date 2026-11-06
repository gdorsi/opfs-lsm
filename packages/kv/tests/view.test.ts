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

describe("view scanRuns", () => {
  async function seeded() {
    const db = await openHarnessDb({
      name: NAME,
      forceMemory: true,
      writerId: "w1",
      ingestPolicy: { maxWalBytes: 1 << 30 },
    });
    await db.put(enc.encode("a"), enc.encode("old"));
    await db.put(enc.encode("b"), enc.encode("old"));
    await db.put(enc.encode("c"), enc.encode("old"));
    await db.ingest();
    await db.put(enc.encode("b"), enc.encode("new"));
    await db.delete(enc.encode("c"));
    await db.put(enc.encode("d"), enc.encode("mem"));
    return db;
  }
  const pairs = (rows: Iterable<{ key: Uint8Array; value: Uint8Array }>) =>
    [...rows].map((r) => `${dec.decode(r.key)}=${dec.decode(r.value)}`);

  it("returns one key-ordered scan per source, unmerged, puts only", async () => {
    const db = await seeded();
    const scans = await db.view((snap) => snap.scanRuns().map(pairs));
    expect(scans.map((s) => s.join(","))).toEqual(["b=new,d=mem", "a=old,b=old,c=old"]);
    await db.close();
  });

  it("honours range bounds in every source", async () => {
    const db = await seeded();
    const scans = await db.view((snap) =>
      snap.scanRuns({ start: enc.encode("b"), endExclusive: enc.encode("d") }).map(pairs),
    );
    expect(scans.map((s) => s.join(","))).toEqual(["b=new", "b=old,c=old"]);
    await db.close();
  });

  it("merging the scans newest first gives what range gives only after dropping shadowed keys", async () => {
    const db = await seeded();
    const merged = await db.view(async (snap) => {
      const seen = new Map<string, string>();
      for (const scan of snap.scanRuns()) {
        for (const e of scan) if (!seen.has(dec.decode(e.key))) seen.set(dec.decode(e.key), dec.decode(e.value));
      }
      const live: string[] = [];
      for (const k of [...seen.keys()].sort()) if ((await snap.get(enc.encode(k))) !== undefined) live.push(`${k}=${seen.get(k)}`);
      const range: string[] = [];
      for await (const e of snap.range()) range.push(`${dec.decode(e.key)}=${dec.decode(e.value)}`);
      return { live, range };
    });
    expect(merged.live).toEqual(merged.range);
    await db.close();
  });

  it("closes with the snapshot", async () => {
    const db = await seeded();
    const snap = await db.view((s) => s);
    expect(() => snap.scanRuns()).toThrow(/closed/);
    await db.close();
  });
});

describe("view scanRuns with a filter", () => {
  it("yields only puts whose value holds every pattern, in each source", async () => {
    const db = await openHarnessDb({ name: NAME, forceMemory: true, writerId: "w1", ingestPolicy: { maxWalBytes: 1 << 30 } });
    await db.put(enc.encode("a"), enc.encode(" red apple"));
    await db.put(enc.encode("b"), enc.encode(" green apple"));
    await db.ingest();
    await db.put(enc.encode("c"), enc.encode(" red pear"));
    await db.put(enc.encode("d"), enc.encode(" blue"));
    const scans = await db.view((snap) =>
      snap.scanRuns(undefined, { valueContains: [enc.encode(" red")] }).map((s) => [...s].map((e) => dec.decode(e.key)).join(",")),
    );
    expect(scans).toEqual(["c", "a"]);
    const both = await db.view((snap) =>
      snap.scanRuns(undefined, { valueContains: [enc.encode(" red"), enc.encode(" apple")] }).map((s) => [...s].map((e) => dec.decode(e.key)).join(",")),
    );
    expect(both).toEqual(["", "a"]);
    await db.close();
  });

  it("hands out bytes that own their buffer", async () => {
    const db = await openHarnessDb({ name: NAME, forceMemory: true, writerId: "w1", ingestPolicy: { maxWalBytes: 1 << 30 } });
    await db.put(enc.encode("a"), enc.encode(" red apple"));
    await db.put(enc.encode("b"), enc.encode(" red pear"));
    await db.ingest();
    await db.put(enc.encode("c"), enc.encode(" red plum"));
    const owned = await db.view((snap) =>
      snap.scanRuns(undefined, { valueContains: [enc.encode(" red")] }).flatMap((s) =>
        [...s].flatMap((e) => [e.key, e.value]).map((b) => b.byteOffset === 0 && b.buffer.byteLength === b.byteLength),
      ),
    );
    expect(owned).toEqual([true, true, true, true, true, true]);
    await db.close();
  });
});

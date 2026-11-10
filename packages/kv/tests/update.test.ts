import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MemoryFs,
  prefixBound
} from "../src/index.js";
import { openHarnessDb, __resetMemoryFsForTests } from "../src/testing.js";

const NAME = "update";
const enc = new TextEncoder();
const dec = new TextDecoder();
const utf = (s: string) => enc.encode(s);
const text = (b: Uint8Array | undefined) => (b ? dec.decode(b) : undefined);

beforeEach(() => __resetMemoryFsForTests(NAME));
afterEach(() => __resetMemoryFsForTests(NAME));

describe("update", () => {
  it("updates on one page never lose each other's writes", async () => {
    const db = await openHarnessDb({ name: NAME, fs: new MemoryFs() });
    const bump = () =>
      db.update([utf("n")], ([cur], tx) => {
        tx.put(utf("n"), utf(String(Number(text(cur) ?? "0") + 1)));
      });
    await Promise.all(Array.from({ length: 20 }, bump));
    expect(text(await db.get(utf("n")))).toBe("20");
    await db.close();
  });

  it("an update reads this page's earlier write that was still waiting for room", async () => {
    const db = await openHarnessDb({ name: NAME, fs: new MemoryFs(), pendingBytes: 1 << 20 });
    const pad = new Uint8Array(600 * 1024);
    const first = db.put(utf("pad1"), pad);
    const second = db.batch((tx) => {
      tx.put(utf("pad2"), pad);
      tx.put(utf("n"), utf("7"));
    });
    const bumped = db.update([utf("n")], ([cur], tx) => {
      tx.put(utf("n"), utf(String(Number(text(cur) ?? "0") + 1)));
    });
    await Promise.all([first, second, bumped]);
    expect(text(await db.get(utf("n")))).toBe("8");
    await db.close();
  });

  it("updates from two pages are last-writer-wins: both pages end on one page's last write", async () => {
    const fs = new MemoryFs();
    const a = await openHarnessDb({ name: NAME, fs });
    const b = await openHarnessDb({ name: NAME, fs });
    const bump = (db: typeof a) =>
      db.update([utf("n")], ([cur], tx) => {
        const next = String(Number(text(cur) ?? "0") + 1);
        tx.put(utf("n"), utf(next));
        return next;
      });
    const wrote = await Promise.all(Array.from({ length: 20 }, (_, i) => bump(i % 2 ? a : b)));
    const lastOf = (page: number) => wrote.filter((_, i) => i % 2 === page).at(-1);
    await a.sync();
    await b.sync();
    const n = text(await a.get(utf("n")));
    expect(text(await b.get(utf("n")))).toBe(n);
    expect([lastOf(0), lastOf(1)]).toContain(n);
    await a.close();
    await b.close();
  });

  it("reads an ingested key in a tab that has not loaded the SST yet", async () => {
    const fs = new MemoryFs();
    const writer = await openHarnessDb({ name: NAME, fs });
    await writer.put(utf("k"), utf("1"));
    await writer.ingest();
    const reader = await openHarnessDb({ name: NAME, fs });
    const seen = await reader.update([utf("k"), utf("absent")], (values) =>
      values.map(text),
    );
    expect(seen).toEqual(["1", undefined]);
    await writer.close();
    await reader.close();
  });

  it("reads this page's writes made before it, even those not acked yet", async () => {
    const db = await openHarnessDb({ name: NAME, fs: new MemoryFs() });
    void db.put(utf("n"), utf("5"));
    await db.update([utf("n")], ([cur], tx) => {
      tx.put(utf("n"), utf(String(Number(text(cur)) + 1)));
    });
    expect(text(await db.get(utf("n")))).toBe("6");
    await db.close();
  });

  it("writes nothing when the body throws", async () => {
    const db = await openHarnessDb({ name: NAME, fs: new MemoryFs() });
    await expect(
      db.update([utf("k")], (_values, tx) => {
        tx.put(utf("k"), utf("x"));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.get(utf("k"))).toBeUndefined();
    await db.close();
  });
});

describe("rangeFollow", () => {
  it("follows each entry to its target across the log and an SST", async () => {
    const fs = new MemoryFs();
    const writer = await openHarnessDb({ name: NAME, fs });
    await writer.batch((tx) => {
      tx.put(utf("doc/1"), utf("one"));
      tx.put(utf("idx/1"), utf("doc/1"));
    });
    await writer.ingest();
    await writer.batch((tx) => {
      tx.put(utf("doc/2"), utf("two"));
      tx.put(utf("idx/2"), utf("doc/2"));
      tx.put(utf("idx/3"), utf("doc/missing"));
    });
    const reader = await openHarnessDb({ name: NAME, fs });
    const hits = await reader.rangeFollow(prefixBound(utf("idx/")), (e) => e.value);
    expect(hits.map((h) => [text(h.entry.key), text(h.value)])).toEqual([
      ["idx/1", "one"],
      ["idx/2", "two"],
      ["idx/3", undefined],
    ]);
    await writer.close();
    await reader.close();
  });

  it("follows the entries of a reverse range, last first", async () => {
    const fs = new MemoryFs();
    const db = await openHarnessDb({ name: NAME, fs });
    await db.batch((tx) => {
      for (const i of [1, 2, 3, 4]) {
        tx.put(utf(`doc/${i}`), utf(`doc ${i}`));
        tx.put(utf(`idx/${i}`), utf(`doc/${i}`));
      }
    });
    await db.ingest();
    await db.batch((tx) => {
      tx.put(utf("doc/5"), utf("doc 5"));
      tx.put(utf("idx/5"), utf("doc/5"));
      tx.delete(utf("idx/2"));
      tx.put(utf("doc/3"), utf("doc 3, newer"));
    });
    const shown = (hits: Awaited<ReturnType<typeof db.rangeFollow>>) =>
      hits.map((h) => `${text(h.entry.key)}>${text(h.value)}`);
    const forward = shown(await db.rangeFollow(prefixBound(utf("idx/")), (e) => e.value));
    expect(forward).toHaveLength(4);
    for (const limit of [undefined, 1, 3]) {
      const range = { ...prefixBound(utf("idx/")), reverse: true, ...(limit !== undefined ? { limit } : {}) };
      expect(shown(await db.rangeFollow(range, (e) => e.value))).toEqual([...forward].reverse().slice(0, limit));
    }
    await db.close();
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MemoryFs,
  prefixBound,
  type Db,
} from "../src/index.js";
import {
  openHarnessDb as openDbRaw,
  __resetMemoryFsForTests,
  type HarnessOpenOptions,
} from "../src/testing.js";

const NAME = "update";
const enc = new TextEncoder();
const dec = new TextDecoder();
const utf = (s: string) => enc.encode(s);
const text = (b: Uint8Array | undefined) => (b ? dec.decode(b) : undefined);
const quiet = { maxWalBytes: 1 << 30 };

/** Every Db a test opened, closed after it even when it fails: an open one stays a live tab. */
const opened: Db[] = [];
async function openHarnessDb(options: HarnessOpenOptions): Promise<Db> {
  const db = await openDbRaw(options);
  opened.push(db);
  return db;
}

/**
 * Drop `db`'s broadcasts of its records, as if each message were lost: its
 * writes reach other tabs only through its log file.
 */
function muteRecords(db: Db): { dropped: number } {
  const bus = (db as unknown as { session: { bus: BroadcastChannel } }).session.bus;
  const post = bus.postMessage.bind(bus);
  const muted = { dropped: 0 };
  bus.postMessage = (msg: { kind?: string }) => {
    if (msg?.kind === "rec") muted.dropped += 1;
    else post(msg);
  };
  return muted;
}

beforeEach(() => {
  __resetMemoryFsForTests(NAME);
});
afterEach(async () => {
  await Promise.all(opened.splice(0).map((db) => db.close()));
  __resetMemoryFsForTests(NAME);
});

describe("update", () => {
  it("concurrent increments from two tabs lose none", async () => {
    const fs = new MemoryFs();
    const a = await openHarnessDb({ name: NAME, writerId: "a", fs, forceMemory: true, ingestPolicy: quiet });
    const b = await openHarnessDb({ name: NAME, writerId: "b", fs, forceMemory: true, ingestPolicy: quiet });
    const bump = (db: typeof a) =>
      db.update([utf("n")], ([cur], tx) => {
        tx.put(utf("n"), utf(String(Number(text(cur) ?? "0") + 1)));
      });
    await Promise.all(Array.from({ length: 20 }, (_, i) => bump(i % 2 ? a : b)));
    // The last increment may be b's: a sees it once it catches up.
    await a.sync();
    expect(text(await a.get(utf("n")))).toBe("20");
    await a.close();
    await b.close();
  });

  it("reads an ingested key in a tab that has not loaded the SST yet", async () => {
    const fs = new MemoryFs();
    const writer = await openHarnessDb({ name: NAME, writerId: "w", fs, forceMemory: true, ingestPolicy: quiet });
    await writer.put(utf("k"), utf("1"));
    await writer.ingest();
    const reader = await openHarnessDb({ name: NAME, writerId: "r", fs, forceMemory: true, ingestPolicy: quiet });
    const seen = await reader.update([utf("k"), utf("absent")], (values) =>
      values.map(text),
    );
    expect(seen).toEqual(["1", undefined]);
    await writer.close();
    await reader.close();
  });

  it("sees a write that was never broadcast", async () => {
    const fs = new MemoryFs();
    const db = await openHarnessDb({ name: NAME, writerId: "a", fs, forceMemory: true, ingestPolicy: quiet });
    const silent = await openHarnessDb({ name: NAME, writerId: "s", fs, forceMemory: true, ingestPolicy: quiet });
    await db.put(utf("n"), utf("1"));
    // The silent tab read "1", so its write sorts after it; only its log file holds it.
    await silent.sync();
    const muted = muteRecords(silent);
    await silent.put(utf("n"), utf("5"));
    await db.update([utf("n")], ([cur], tx) => {
      tx.put(utf("n"), utf(String(Number(text(cur)) + 1)));
    });
    expect(text(await db.get(utf("n")))).toBe("6");
    expect(muted.dropped).toBe(1);
  });

  it("writes nothing when the body throws", async () => {
    const db = await openHarnessDb({ name: NAME, writerId: "w", fs: new MemoryFs(), forceMemory: true, ingestPolicy: quiet });
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
    const writer = await openHarnessDb({ name: NAME, writerId: "w", fs, forceMemory: true, ingestPolicy: quiet });
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
    const reader = await openHarnessDb({ name: NAME, writerId: "r", fs, forceMemory: true, ingestPolicy: quiet });
    const hits = await reader.rangeFollow(prefixBound(utf("idx/")), (e) => e.value);
    expect(hits.map((h) => [text(h.entry.key), text(h.value)])).toEqual([
      ["idx/1", "one"],
      ["idx/2", "two"],
      ["idx/3", undefined],
    ]);
    await writer.close();
    await reader.close();
  });
});

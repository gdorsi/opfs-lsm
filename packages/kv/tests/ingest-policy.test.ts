import { afterEach, describe, expect, it } from "vitest";
import {
  EngineHost,
  MemoryFs,
  __resetMemoryFsForTests,
  createLocalIngestClient,
  openDb,
  type IngestPolicy,
} from "../src/index.js";
import { checkDbName, opsBytes } from "../src/check.js";
import { IdBWal } from "../src/idb/wal.js";
import { loadLatestGeneration } from "../src/store/generation.js";

const enc = new TextEncoder();
const utf = (s: string) => enc.encode(s);
const NAME = "policy";

afterEach(async () => {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${NAME}`);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
  __resetMemoryFsForTests(NAME);
});

async function twoTabs(policy: IngestPolicy) {
  const fs = new MemoryFs();
  const host = new EngineHost(() => fs);
  let requests = 0;
  const open = (writerId: string) => {
    const inner = createLocalIngestClient(host);
    return openDb({
      name: NAME,
      writerId,
      fs,
      ingestPolicy: policy,
      ingest: {
        ingest: (name, through) => {
          requests += 1;
          return inner.ingest(name, through);
        },
        close: () => inner.close(),
      },
    });
  };
  const a = await open("a");
  const b = await open("b");
  return { fs, a, b, requests: () => requests };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
}

describe("ingest policy", () => {
  it("flushes once when the waiting WAL passes maxWalBytes, whichever tab wrote", async () => {
    const { fs, a, b, requests } = await twoTabs({ maxWalBytes: 100 });
    await a.put(utf("a"), new Uint8Array(60));
    await settle();
    expect(await loadLatestGeneration(fs)).toBeUndefined();
    await b.put(utf("b"), new Uint8Array(60));
    await b.put(utf("c"), new Uint8Array(1));
    await settle();
    expect(requests()).toBe(2);
    const gen = await loadLatestGeneration(fs);
    expect(gen?.runs).toHaveLength(1);
    expect((await a.get(utf("c")))?.byteLength).toBe(1);
    await a.close();
    await b.close();
  });

  it("a second request for the same flush publishes nothing new", async () => {
    const fs = new MemoryFs();
    const host = new EngineHost(() => fs);
    const db = await openDb({
      name: NAME,
      writerId: "a",
      fs,
      ingest: createLocalIngestClient(host),
      ingestPolicy: { maxWalBytes: 1e9 },
    });
    await db.put(utf("a"), utf("1"));
    expect((await host.ingest(NAME, 1)).generation).toBe(1);
    await db.put(utf("b"), utf("2"));
    expect((await host.ingest(NAME, 1)).generation).toBe(1);
    expect((await loadLatestGeneration(fs))?.runs).toHaveLength(1);
    await db.close();
  });

  it("counts overwrites of one key, which leave the memtable the same size", async () => {
    const { fs, a, b } = await twoTabs({ maxWalBytes: 20 });
    await a.put(utf("k"), utf("1".repeat(8)));
    await b.put(utf("k"), utf("2".repeat(8)));
    await settle();
    expect(await loadLatestGeneration(fs)).toBeUndefined();
    await a.put(utf("k"), utf("3".repeat(8)));
    await settle();
    expect((await loadLatestGeneration(fs))?.runs).toHaveLength(1);
    expect(new TextDecoder().decode(await b.get(utf("k")))).toBe("3".repeat(8));
    await a.close();
    await b.close();
  });

  it("keeps the waiting WAL under the limit plus one batch, for overwrites and deletes", async () => {
    const limit = 4_000;
    const { a, b } = await twoTabs({ maxWalBytes: limit });
    const keys = Array.from({ length: 50 }, (_, i) => utf(`key/${String(i).padStart(4, "0")}`));
    const wal = await IdBWal.open(checkDbName(NAME));
    let largest = 0;
    for (let round = 0; round < 40; round++) {
      await a.batch((tx) => {
        for (const k of keys) round % 2 ? tx.delete(k) : tx.put(k, new Uint8Array(40));
      });
      await settle();
      const waiting = (await wal.tail(0)).records.reduce((n, r) => n + opsBytes(r.ops), 0);
      largest = Math.max(largest, waiting);
    }
    wal.close();
    expect(largest).toBeLessThanOrEqual(limit + 50 * 48);
    expect(await b.get(keys[0]!)).toBeUndefined();
    await a.close();
    await b.close();
  });
});

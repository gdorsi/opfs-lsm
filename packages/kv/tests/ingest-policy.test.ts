import { afterEach, describe, expect, it } from "vitest";
import {
  EngineHost,
  MemoryFs,
  __resetMemoryFsForTests,
  createLocalIngestClient,
  openDb,
  type IngestPolicy,
} from "../src/index.js";
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
  it("flushes once when the memtable passes maxBytes, whichever tab wrote", async () => {
    const { fs, a, b, requests } = await twoTabs({ maxBatches: 1e9, maxBytes: 100 });
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
      ingestPolicy: { maxBatches: 1e9, maxBytes: 1e9 },
    });
    await db.put(utf("a"), utf("1"));
    expect((await host.ingest(NAME, 1)).generation).toBe(1);
    await db.put(utf("b"), utf("2"));
    expect((await host.ingest(NAME, 1)).generation).toBe(1);
    expect((await loadLatestGeneration(fs))?.runs).toHaveLength(1);
    await db.close();
  });

  it("flushes after maxBatches records that overwrite one key", async () => {
    const { fs, a, b } = await twoTabs({ maxBatches: 3, maxBytes: 1e9 });
    await a.put(utf("k"), utf("1"));
    await b.put(utf("k"), utf("2"));
    await settle();
    expect(await loadLatestGeneration(fs)).toBeUndefined();
    await a.put(utf("k"), utf("3"));
    await settle();
    expect((await loadLatestGeneration(fs))?.runs).toHaveLength(1);
    expect(new TextDecoder().decode(await b.get(utf("k")))).toBe("3");
    await a.close();
    await b.close();
  });
});

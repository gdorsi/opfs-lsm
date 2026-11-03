import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EngineHost,
  MemoryFs,
  __resetMemoryFsForTests,
  createLocalIngestClient,
  openDb,
} from "../src/index.js";
import { IngestScheduler } from "../src/ingest-policy.js";

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
  vi.useRealTimers();
  await deleteIdb("policy");
  __resetMemoryFsForTests("policy");
});

describe("ingest policy", () => {
  it("auto-ingests when maxBatches is reached", async () => {
    const fs = new MemoryFs();
    const host = new EngineHost(() => fs);
    let calls = 0;
    const inner = createLocalIngestClient(host);
    const ingest = {
      ingest: async (name: string) => {
        calls += 1;
        return inner.ingest(name);
      },
      close: () => inner.close(),
    };
    const db = await openDb({
      name: "policy",
      writerId: "w1",
      fs,
      ingest,
      forceMemory: true,
      ingestPolicy: { maxBatches: 2, maxBytes: 1 << 30, maxDelayMs: 60_000 },
    });
    await db.put(utf("a"), utf("1"));
    expect(calls).toBe(0);
    await db.put(utf("b"), utf("2"));
    await db.ingest();
    expect(calls).toBeGreaterThanOrEqual(1);
    const v = await db.get(utf("a"));
    expect(v && new TextDecoder().decode(v)).toBe("1");
    await db.close();
  });

  it("IngestScheduler fires after maxDelayMs", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const sched = new IngestScheduler({ maxBatches: 100, maxBytes: 1 << 30, maxDelayMs: 50 }, async () => {
      calls += 1;
      return { generation: calls };
    });
    sched.noteAppend(10);
    expect(calls).toBe(0);
    await vi.advanceTimersByTimeAsync(50);
    await Promise.resolve();
    expect(calls).toBe(1);
    sched.close();
  });
});

import { afterEach, describe, expect, it } from "vitest";
import {
  openHarnessDb,
  __resetMemoryFsForTests,
  type OpenSpan,
  type OpenTrace,
} from "../src/testing.js";

const NAME = "open-trace";
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

function phase(trace: OpenTrace, name: string): OpenSpan | undefined {
  return trace.spans.find((span) => span.phase === name);
}

afterEach(async () => {
  await wipe();
  __resetMemoryFsForTests(NAME);
});

describe("open trace", () => {
  it("times the WAL replay that open waits for", async () => {
    const writer = await openHarnessDb({
      name: NAME,
      forceMemory: true,
      writerId: "w1",
      maxWalBytes: 1 << 30,
    });
    await writer.put(enc.encode("a"), enc.encode("1"));
    await writer.put(enc.encode("b"), enc.encode("2"));
    await writer.put(enc.encode("c"), enc.encode("3"));
    await writer.close();

    const trace: OpenTrace = { spans: [] };
    const reader = await openHarnessDb({
      name: NAME,
      forceMemory: true,
      writerId: "w2",
      maxWalBytes: 1 << 30,
      trace,
    });
    expect(dec.decode(await reader.get(enc.encode("b")))).toBe("2");
    expect(phase(trace, "wal-read")?.rows).toBe(3);
    expect(phase(trace, "memtable")?.rows).toBe(3);
    expect(phase(trace, "sync")?.ms).toBeGreaterThanOrEqual(0);
    const sync = phase(trace, "sync")?.ms ?? 0;
    const replay = (phase(trace, "wal-read")?.ms ?? 0) + (phase(trace, "memtable")?.ms ?? 0);
    expect(replay).toBeLessThanOrEqual(sync + 5);
    await reader.close();
  });

  it("reopens every acked put from the WAL", async () => {
    const writer = await openHarnessDb({
      name: NAME,
      forceMemory: true,
      writerId: "w1",
      maxWalBytes: 1 << 30,
    });
    const n = 200;
    for (let i = 0; i < n; i++) {
      await writer.put(enc.encode(`k${i}`), enc.encode(`v${i}`));
    }
    await writer.close();

    const reader = await openHarnessDb({
      name: NAME,
      forceMemory: true,
      writerId: "w2",
      maxWalBytes: 1 << 30,
    });
    for (let i = 0; i < n; i++) {
      expect(dec.decode(await reader.get(enc.encode(`k${i}`)))).toBe(`v${i}`);
    }
    const seen: string[] = [];
    for (const entry of await reader.range()) {
      seen.push(dec.decode(entry.key));
    }
    expect(seen).toHaveLength(n);
    await reader.close();
  });
});

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

function phase(trace: OpenTrace, name: string): OpenSpan | undefined {
  return trace.spans.find((span) => span.phase === name);
}

afterEach(() => {
  __resetMemoryFsForTests(NAME);
});

describe("open trace", () => {
  it("times the log replay that open waits for", async () => {
    const writer = await openHarnessDb({
      name: NAME,
      forceMemory: true,
      writerId: "w1",
      ingestPolicy: { maxWalBytes: 1 << 30 },
    });
    try {
      await writer.put(enc.encode("a"), enc.encode("1"));
      await writer.put(enc.encode("b"), enc.encode("2"));
      await writer.put(enc.encode("c"), enc.encode("3"));
    } finally {
      await writer.close();
    }

    const trace: OpenTrace = { spans: [] };
    const reader = await openHarnessDb({
      name: NAME,
      forceMemory: true,
      writerId: "w2",
      ingestPolicy: { maxWalBytes: 1 << 30 },
      trace,
    });
    try {
      // The spans open recorded: a later sync appends more "log" spans.
      const opened: OpenTrace = { spans: [...trace.spans] };
      expect(dec.decode(await reader.get(enc.encode("b")))).toBe("2");
      for (const name of ["generation", "join", "log", "sync", "open"]) {
        const ms = phase(opened, name)?.ms;
        if (ms === undefined) throw new Error(`open recorded no ${name} span`);
        expect(ms).toBeGreaterThanOrEqual(0);
      }
      // Joining the tabs and reading the writer's log both happen inside the
      // sync phase that open waits for, and open covers all of it.
      const sync = phase(opened, "sync")!;
      const replay = phase(opened, "join")!.ms + phase(opened, "log")!.ms;
      expect(replay).toBeLessThanOrEqual(sync.ms + 5);
      expect(phase(opened, "log")!.endedAt).toBeLessThanOrEqual(sync.endedAt);
      expect(sync.ms).toBeLessThanOrEqual(phase(opened, "open")!.ms);
    } finally {
      await reader.close();
    }
  });

  it("reopens every acked put from the log", async () => {
    const writer = await openHarnessDb({
      name: NAME,
      forceMemory: true,
      writerId: "w1",
      ingestPolicy: { maxWalBytes: 1 << 30 },
    });
    const n = 200;
    try {
      for (let i = 0; i < n; i++) {
        await writer.put(enc.encode(`k${i}`), enc.encode(`v${i}`));
      }
    } finally {
      await writer.close();
    }

    const reader = await openHarnessDb({
      name: NAME,
      forceMemory: true,
      writerId: "w2",
      ingestPolicy: { maxWalBytes: 1 << 30 },
    });
    try {
      for (let i = 0; i < n; i++) {
        expect(dec.decode(await reader.get(enc.encode(`k${i}`)))).toBe(`v${i}`);
      }
      const seen: string[] = [];
      for await (const entry of reader.range()) {
        seen.push(dec.decode(entry.key));
      }
      expect(seen).toHaveLength(n);
    } finally {
      await reader.close();
    }
  });
});

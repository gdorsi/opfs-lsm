import { afterEach, describe, expect, it } from "vitest";
import { openHarnessDb, __resetMemoryFsForTests, type OpenSpan, type OpenTrace } from "../src/testing.js";

const NAME = "open-trace";
const enc = new TextEncoder();
const dec = new TextDecoder();

function phase(trace: OpenTrace, name: string): OpenSpan | undefined {
  return trace.spans.find((span) => span.phase === name);
}

afterEach(() => __resetMemoryFsForTests(NAME));

describe("open trace", () => {
  it("times the attach that ingests a closed page's log, and the load of the manifest it published", async () => {
    const writer = await openHarnessDb({ name: NAME, forceMemory: true });
    await writer.put(enc.encode("a"), enc.encode("1"));
    await writer.put(enc.encode("b"), enc.encode("2"));
    await writer.put(enc.encode("c"), enc.encode("3"));
    await writer.close();

    const trace: OpenTrace = { spans: [] };
    const reader = await openHarnessDb({ name: NAME, forceMemory: true, trace });
    expect(dec.decode(await reader.get(enc.encode("b")))).toBe("2");
    expect(phase(trace, "attach")?.ms).toBeGreaterThanOrEqual(0);
    expect(phase(trace, "load")?.rows, "one L0 run").toBe(1);
    const open = phase(trace, "open")!.ms;
    expect(phase(trace, "attach")!.ms + phase(trace, "load")!.ms).toBeLessThanOrEqual(open + 5);
    await reader.close();
  });

  it("reopens every acked put", async () => {
    const writer = await openHarnessDb({ name: NAME, forceMemory: true });
    const n = 200;
    for (let i = 0; i < n; i++) {
      await writer.put(enc.encode(`k${i}`), enc.encode(`v${i}`));
    }
    await writer.close();

    const reader = await openHarnessDb({ name: NAME, forceMemory: true });
    for (let i = 0; i < n; i++) {
      expect(dec.decode(await reader.get(enc.encode(`k${i}`)))).toBe(`v${i}`);
    }
    const seen: string[] = [];
    for await (const entry of reader.range()) {
      seen.push(dec.decode(entry.key));
    }
    expect(seen).toHaveLength(n);
    await reader.close();
  });
});

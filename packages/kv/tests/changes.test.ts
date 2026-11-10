import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ChangeEvent } from "../src/index.js";
import { openHarnessDb, __resetMemoryFsForTests } from "../src/testing.js";

const NAME = "changes-test";
const enc = new TextEncoder();

beforeEach(() => __resetMemoryFsForTests(NAME));
afterEach(() => __resetMemoryFsForTests(NAME));

async function until(what: string, ok: () => boolean, ms = 3000): Promise<void> {
  for (const end = Date.now() + ms; !ok(); ) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("changes()", () => {
  it("notifies this page's acked writes, then the install that holds them", async () => {
    const db = await openHarnessDb({ name: NAME, forceMemory: true });
    const events: ChangeEvent[] = [];
    const stop = db.changes((e) => events.push(e));

    await db.put(enc.encode("a"), enc.encode("1"));
    expect(events).toEqual([{ kind: "local" }]);

    const { generation } = await db.ingest();
    expect(events.at(-1)).toEqual({ kind: "ingest", generation });

    stop();
    await db.put(enc.encode("b"), enc.encode("2"));
    expect(events.filter((e) => e.kind === "local")).toHaveLength(1);
    await db.close();
  });

  it("hears another page's writes as an install, once the host ingests them", async () => {
    const a = await openHarnessDb({ name: NAME, forceMemory: true });
    const b = await openHarnessDb({ name: NAME, forceMemory: true });
    const events: ChangeEvent[] = [];
    b.changes((e) => events.push(e));

    await a.put(enc.encode("k"), enc.encode("v"));
    expect(await b.get(enc.encode("k")), "not ingested yet").toBeUndefined();
    await until("b's install", () => events.some((e) => e.kind === "ingest"));
    expect(events.every((e) => e.kind === "ingest"), "a's write is not local to b").toBe(true);
    expect(new TextDecoder().decode(await b.get(enc.encode("k")))).toBe("v");
    await a.close();
    await b.close();
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EngineHost,
  MemoryFs,
  attachEngineHostPort,
  createPortIngestClient,
  type Db,
} from "../src/index.js";
import {
  openHarnessDb as openDbRaw,
  __resetMemoryFsForTests,
  type HarnessOpenOptions,
} from "../src/testing.js";
import { loadLatestGeneration } from "../src/store/generation.js";

const NAME = "wal-cache-test";
const enc = new TextEncoder();
const dec = new TextDecoder();

/** Every Db a test opened, closed after it even when it fails: an open one stays a live tab. */
const opened: Db[] = [];
async function openHarnessDb(options: HarnessOpenOptions): Promise<Db> {
  const db = await openDbRaw(options);
  opened.push(db);
  return db;
}

beforeEach(() => {
  __resetMemoryFsForTests(NAME);
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map((db) => db.close()));
  __resetMemoryFsForTests(NAME);
});

describe("memtable reads", () => {
  it("serves repeated gets without losing visibility", async () => {
    const db = await openHarnessDb({
      name: NAME,
      forceMemory: true,
      writerId: "w1",
      ingestPolicy: { maxWalBytes: 1 << 30 },
    });
    await db.put(enc.encode("a"), enc.encode("1"));
    expect(dec.decode(await db.get(enc.encode("a")))).toBe("1");
    expect(dec.decode(await db.get(enc.encode("a")))).toBe("1");
    await db.put(enc.encode("a"), enc.encode("2"));
    expect(dec.decode(await db.get(enc.encode("a")))).toBe("2");
    await db.close();
  });

  it("invalidates after ingest so SST still serves values", async () => {
    const db = await openHarnessDb({
      name: NAME,
      forceMemory: true,
      writerId: "w1",
      ingestPolicy: { maxWalBytes: 1 << 30 },
    });
    await db.put(enc.encode("k"), enc.encode("v"));
    await db.ingest();
    expect(dec.decode(await db.get(enc.encode("k")))).toBe("v");
    await db.close();
  });

  it("reads a key folded by a host ingest after SST readers were warmed", async () => {
    const fs = new MemoryFs();
    const host = new EngineHost(() => fs);
    const { port1, port2 } = new MessageChannel();
    attachEngineHostPort(port1, host);
    const ingest = createPortIngestClient(port2);
    const policy = {
      maxWalBytes: 1 << 30,
    };
    const a = await openHarnessDb({
      name: NAME,
      writerId: "w1",
      fs,
      ingest,
      ingestPolicy: policy,
    });
    const b = await openHarnessDb({
      name: NAME,
      writerId: "w2",
      fs,
      ingest,
      ingestPolicy: policy,
    });

    await a.put(enc.encode("seed"), enc.encode("s"));
    await a.ingest();
    expect(dec.decode((await a.get(enc.encode("seed")))!)).toBe("s");

    await b.put(enc.encode("k"), enc.encode("v"));
    // The host folds only through the lowest last record of the live tabs:
    // a writes after reading "k", so the host may fold "k" without asking.
    await a.sync();
    await a.put(enc.encode("later"), enc.encode("l"));
    const published = await host.ingest(NAME, Number.POSITIVE_INFINITY);
    expect(published.generation).toBe(2);
    expect((await loadLatestGeneration(fs))!.through).toBe(2);

    // a installs the new generation, which covers "k", so the read comes from its run.
    await a.sync();
    const got = await a.get(enc.encode("k"));
    expect(got && dec.decode(got)).toBe("v");
    expect(dec.decode((await a.get(enc.encode("later")))!)).toBe("l");

    await a.close();
    await b.close();
    ingest.close();
    port1.close();
    port2.close();
  });
});

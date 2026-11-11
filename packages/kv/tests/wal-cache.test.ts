import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  openHarnessDb,
  __resetMemoryFsForTests,
  ingest as ingestDb,
  EngineHost,
  MemoryFs,
  attachEngineHostPort,
  createPortIngestClient,
} from "../src/testing.js";

const NAME = "wal-cache-test";
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

beforeEach(async () => {
  __resetMemoryFsForTests(NAME);
  await wipe();
});

afterEach(() => {
  __resetMemoryFsForTests(NAME);
});

describe("memtable reads", () => {
  it("serves repeated gets without losing visibility", async () => {
    const db = await openHarnessDb({
      name: NAME,
      forceMemory: true,
      writerId: "w1",
      maxWalBytes: 1 << 30,
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
      maxWalBytes: 1 << 30,
    });
    await db.put(enc.encode("k"), enc.encode("v"));
    await ingestDb(db);
    expect(dec.decode(await db.get(enc.encode("k")))).toBe("v");
    await db.close();
  });

  it("reads a key folded by a host ingest after SST readers were warmed", async () => {
    const fs = new MemoryFs();
    const host = new EngineHost(() => fs);
    const { port1, port2 } = new MessageChannel();
    attachEngineHostPort(port1, host);
    const ingest = createPortIngestClient(port2);
    const maxWalBytes = 1 << 30;
    const a = await openHarnessDb({
      name: NAME,
      writerId: "w1",
      fs,
      ingest,
      maxWalBytes,
    });
    const b = await openHarnessDb({
      name: NAME,
      writerId: "w2",
      fs,
      ingest,
      maxWalBytes,
    });

    await a.put(enc.encode("seed"), enc.encode("s"));
    await ingestDb(a);
    expect(dec.decode((await a.get(enc.encode("seed")))!)).toBe("s");

    await b.put(enc.encode("k"), enc.encode("v"));
    const published = await host.ingest(NAME);
    expect(published.generation).toBe(2);

    const got = await a.get(enc.encode("k"));
    expect(got && dec.decode(got)).toBe("v");

    await a.close();
    await b.close();
    ingest.close();
    port1.close();
    port2.close();
  });
});

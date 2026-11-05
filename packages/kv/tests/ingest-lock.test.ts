import { afterEach, describe, expect, it } from "vitest";
import {
  EngineHost,
  MemoryFs,
  __resetMemoryFsForTests,
  createLocalIngestClient,
  openDb,
} from "../src/index.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const utf = (s: string) => enc.encode(s);

afterEach(async () => {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase("opfs-lsm-wal/lock-db");
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
  __resetMemoryFsForTests("lock-db");
});

describe("ingest across two hosts", () => {
  it("never loses a write when two SharedWorkers ingest at once", async () => {
    const fs = new MemoryFs();
    const policy = { maxWalBytes: 1e12 };
    const a = await openDb({
      name: "lock-db",
      writerId: "a",
      fs,
      ingest: createLocalIngestClient(new EngineHost(() => fs)),
      ingestPolicy: policy,
    });
    const b = await openDb({
      name: "lock-db",
      writerId: "b",
      fs,
      ingest: createLocalIngestClient(new EngineHost(() => fs)),
      ingestPolicy: policy,
    });
    for (let round = 0; round < 6; round++) {
      await a.put(utf(`a${round}`), utf(`${round}`));
      await b.put(utf(`b${round}`), utf(`${round}`));
      await Promise.all([a.ingest(), b.ingest()]);
    }
    const fresh = await openDb({
      name: "lock-db",
      writerId: "c",
      fs,
      ingest: createLocalIngestClient(new EngineHost(() => fs)),
      ingestPolicy: policy,
    });
    for (let round = 0; round < 6; round++) {
      for (const who of ["a", "b"]) {
        const got = await fresh.get(utf(`${who}${round}`));
        expect(got && dec.decode(got), `${who}${round}`).toBe(`${round}`);
      }
    }
    await Promise.all([a.close(), b.close(), fresh.close()]);
  });
});

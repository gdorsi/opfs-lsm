import { afterEach, describe, expect, it } from "vitest";
import {
  openHarnessDb,
  __resetMemoryFsForTests,
  ingest,
  EngineHost,
  MemoryFs,
  createLocalIngestClient,
} from "../src/testing.js";

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

/** Cross-host exclusion is the Web Lock. Node 22 has no LockManager. */
function hasWebLocks(): boolean {
  return (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks !== undefined;
}

describe("ingest across two hosts", () => {
  it("never loses a write when two SharedWorkers ingest at once", async (ctx) => {
    if (!hasWebLocks()) {
      ctx.skip(
        "navigator.locks is missing, so two hosts are not serialized. Node 24 and CI have the Web Lock API; Node 22 does not.",
      );
    }
    const fs = new MemoryFs();
    const policy = { maxWalBytes: 1e12 };
    const a = await openHarnessDb({
      name: "lock-db",
      writerId: "a",
      fs,
      ingest: createLocalIngestClient(new EngineHost(() => fs)),
      ingestPolicy: policy,
    });
    const b = await openHarnessDb({
      name: "lock-db",
      writerId: "b",
      fs,
      ingest: createLocalIngestClient(new EngineHost(() => fs)),
      ingestPolicy: policy,
    });
    for (let round = 0; round < 6; round++) {
      await a.put(utf(`a${round}`), utf(`${round}`));
      await b.put(utf(`b${round}`), utf(`${round}`));
      await Promise.all([ingest(a), ingest(b)]);
    }
    const fresh = await openHarnessDb({
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

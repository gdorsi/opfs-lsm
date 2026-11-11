import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EngineHost,
  MemoryFs,
  StorageFullError,
  StorageUnavailableError,
  attachEngineHostPort,
  createLocalIngestClient,
  createPortIngestClient,
  type OpfsLsmError,
} from "../src/index.js";
import { reclaimManifests } from "../src/store/generation.js";
import { openHarnessDb, ingest } from "../src/testing.js";
import { checkDatabase, deleteWal } from "./sim/check-database.js";
import { FaultFs, Faults } from "./sim/fault-fs.js";

const NAME = "kill-loop-gaps";
const enc = new TextEncoder();
const utf = (s: string) => enc.encode(s);

function mft(generation: number): string {
  return `m/${String(generation).padStart(16, "0")}.mft`;
}

async function touch(fs: MemoryFs, path: string): Promise<void> {
  const w = await fs.create(path);
  await w.write(utf("partial"));
  await w.finish();
}

afterEach(async () => {
  vi.restoreAllMocks();
  await deleteWal(NAME);
});

describe("a createWritable swap file a browser crash left in m/", () => {
  it("goes with the manifests reclaim removes, and once its generation is recorded", async () => {
    const fs = new MemoryFs();
    for (const path of [mft(4), `${mft(4)}.crswap`, mft(5), `${mft(5)}.crswap`]) await touch(fs, path);
    await reclaimManifests(fs, 5);
    expect(fs.publishedPaths()).toEqual([mft(5)]);
  });

  it("stays while a write of its manifest can still be in progress", async () => {
    const fs = new MemoryFs();
    for (const path of [mft(5), `${mft(6)}.crswap`]) await touch(fs, path);
    await reclaimManifests(fs, 5);
    expect(fs.publishedPaths()).toEqual([mft(5), `${mft(6)}.crswap`]);
  });

  it("is gone after the next flush, and checkDatabase lists none", async () => {
    const fs = new MemoryFs();
    const open = () => openHarnessDb({ name: NAME, fs, ingest: createLocalIngestClient(new EngineHost(() => fs)) });
    let db = await open();
    await db.put(utf("a"), utf("1"));
    await ingest(db);
    await db.close();
    // The browser died while the host wrote manifest 2.
    await touch(fs, `${mft(2)}.crswap`);
    expect((await checkDatabase(fs, NAME)).swapFiles).toEqual([`${mft(2)}.crswap`]);
    db = await open();
    await db.put(utf("b"), utf("2"));
    await ingest(db);
    await db.close();
    const report = await checkDatabase(fs, NAME);
    expect(report.swapFiles).toEqual([]);
    expect(report.problems).toEqual([]);
  });
});

/** Make every `indexedDB.open` fail the way Chrome does once it has damaged its own store. */
function failIdbOpen(): DOMException {
  const error = new DOMException("Internal error opening backing store for indexedDB.open.", "UnknownError");
  vi.spyOn(indexedDB, "open").mockImplementation(() => {
    const req = { error, onerror: null as (() => void) | null };
    queueMicrotask(() => req.onerror?.());
    return req as unknown as IDBOpenDBRequest;
  });
  return error;
}

describe("an indexedDB.open that fails with UnknownError", () => {
  it("rejects openDb with StorageUnavailableError and keeps the browser's error as cause", async () => {
    const cause = failIdbOpen();
    const err = await openHarnessDb({ name: NAME, forceMemory: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageUnavailableError);
    expect((err as OpfsLsmError).code).toBe("unavailable");
    expect((err as Error).cause).toBe(cause);
    expect((err as Error).message).toMatch(/IndexedDB/);
  });

  it("reaches a tab from the host as StorageUnavailableError", async () => {
    failIdbOpen();
    const { port1, port2 } = new MessageChannel();
    attachEngineHostPort(port1, new EngineHost(() => new MemoryFs()));
    const client = createPortIngestClient(port2);
    const err = await client.ingest(NAME, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageUnavailableError);
    expect((err as Error).message).toMatch(/IndexedDB/);
    client.close();
    port1.close();
  });
});

describe("an OPFS write that fails with QuotaExceededError in the host", () => {
  it("rejects the tab's ingest() with StorageFullError, and the database stays clean", async () => {
    const mem = new MemoryFs();
    const faults = new Faults();
    faults.kinds = new Set();
    faults.error = () => new DOMException("The operation failed because it would cause the application to exceed its storage quota.", "QuotaExceededError");
    const { port1, port2 } = new MessageChannel();
    attachEngineHostPort(port1, new EngineHost(() => new FaultFs(mem, faults)));
    const open = () => openHarnessDb({ name: NAME, fs: mem, ingest: createPortIngestClient(port2) });
    let db = await open();
    await db.put(utf("a"), utf("1"));

    faults.kinds = new Set(["fs-write"]);
    faults.failAt = 1;
    faults.persistent = true;
    const err = await ingest(db).catch((e: unknown) => e);
    expect(faults.injected, "the quota error fired").toBeGreaterThan(0);
    expect(err).toBeInstanceOf(StorageFullError);
    expect((err as OpfsLsmError).code).toBe("quota");

    faults.heal();
    await db.close();
    expect((await checkDatabase(mem, NAME)).problems).toEqual([]);
    db = await open();
    await ingest(db);
    expect(await db.get(utf("a"))).toEqual(utf("1"));
    await db.close();
    port1.close();
  });
});

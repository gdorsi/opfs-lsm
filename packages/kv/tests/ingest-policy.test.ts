import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  EngineHost,
  MemoryFs,
  createLocalIngestClient,
  type AsyncFs,
  type ChangeEvent,
  type Db,
  type IngestPolicy
} from "../src/index.js";
import {
  openHarnessDb,
  __resetMemoryFsForTests
} from "../src/testing.js";
import { checkDbName, checkKey, checkValue, opsBytes } from "../src/check.js";
import { IdBWal } from "../src/idb/wal.js";
import { loadLatestGeneration } from "../src/store/generation.js";

const enc = new TextEncoder();
const utf = (s: string) => enc.encode(s);
const NAME = "policy";
const WAIT = { timeout: 2000, interval: 5 };
/** A failed test leaves tabs open, and their host would ingest the next test's WAL. */
const opened: Db[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of opened.splice(0)) await db.close();
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${NAME}`);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
  __resetMemoryFsForTests(NAME);
});

async function open(host: EngineHost, fs: AsyncFs, writerId: string, policy: IngestPolicy) {
  const db = await openHarnessDb({
    name: NAME,
    writerId,
    fs,
    ingestPolicy: policy,
    ingest: createLocalIngestClient(host),
  });
  opened.push(db);
  return db;
}

async function twoTabs(policy: IngestPolicy) {
  const fs = new MemoryFs();
  const host = new EngineHost(() => fs);
  const a = await open(host, fs, "a", policy);
  const b = await open(host, fs, "b", policy);
  return { fs, a, b };
}

function ingestEvents(db: Db): ChangeEvent[] {
  const events: ChangeEvent[] = [];
  db.changes((e) => {
    if (e.kind === "ingest") events.push(e);
  });
  return events;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
}

/** MemoryFs whose L0 writes can be held or made to fail. */
function l0Fs() {
  const inner = new MemoryFs();
  const state = {
    fail: false,
    hold: undefined as Promise<void> | undefined,
    started: 0,
    inFlight: 0,
    maxInFlight: 0,
  };
  const fs: AsyncFs = {
    read: (path, offset, length) => inner.read(path, offset, length),
    list: (dir) => inner.list(dir),
    remove: (path) => inner.remove(path),
    open: (path) => inner.open(path),
    removeUnlessOpen: (path) => inner.removeUnlessOpen(path),
    create: async (path) => {
      if (!path.startsWith("l0/")) return inner.create(path);
      if (state.fail) throw new Error("disk full");
      state.started += 1;
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      await state.hold;
      const w = await inner.create(path);
      return {
        write: (bytes) => w.write(bytes),
        finish: async () => {
          await w.finish();
          state.inFlight -= 1;
        },
        abort: () => w.abort(),
      };
    },
  };
  return { fs, state };
}

describe("ingest policy", () => {
  it("the host ingests once the waiting WAL passes maxWalBytes, whichever tab wrote", async () => {
    const { fs, a, b } = await twoTabs({ maxWalBytes: 100 });
    const seen = ingestEvents(a);
    await a.put(utf("a"), new Uint8Array(60));
    await settle();
    expect(await loadLatestGeneration(fs)).toBeUndefined();
    await b.put(utf("b"), new Uint8Array(60));
    await b.put(utf("c"), new Uint8Array(1));
    await vi.waitFor(() => expect(seen).toHaveLength(1), WAIT);
    await settle();
    const gen = await loadLatestGeneration(fs);
    expect(gen?.runs).toHaveLength(1);
    expect((await a.get(utf("c")))?.byteLength).toBe(1);
    await a.close();
    await b.close();
  });

  it("a reopened database uses the stored WAL size", async () => {
    const fs = new MemoryFs();
    const host = new EngineHost(() => fs);
    const writer = await open(host, fs, "a", { maxWalBytes: 1 << 30 });
    await writer.put(utf("a"), new Uint8Array(40));
    await writer.close();

    const under = await open(host, fs, "b", { maxWalBytes: 100 });
    await settle();
    expect(await loadLatestGeneration(fs)).toBeUndefined();
    expect((await under.get(utf("a")))?.byteLength).toBe(40);
    await under.close();

    const more = await open(host, fs, "c", { maxWalBytes: 1 << 30 });
    await more.put(utf("b"), new Uint8Array(80));
    await more.close();
    const over = await open(host, fs, "d", { maxWalBytes: 50 });
    await vi.waitFor(
      async () => expect((await loadLatestGeneration(fs))?.runs).toHaveLength(1),
      WAIT,
    );
    expect((await over.get(utf("a")))?.byteLength).toBe(40);
    expect((await over.get(utf("b")))?.byteLength).toBe(80);
    await over.close();
  });

  it("drops only the folded bytes from the WAL counter", async () => {
    // Its own database: a host from an earlier test may still be ingesting
    // NAME, and recovery would pair that host's manifests with this WAL.
    const name = `${NAME}-counter`;
    onTestFinished(
      () =>
        new Promise<void>((resolve) => {
          const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${name}`);
          req.onsuccess = req.onerror = req.onblocked = () => resolve();
        }),
    );
    const wal = await IdBWal.open(checkDbName(name));
    expect(await wal.uningestedBytes()).toBe(0);
    const first = {
      type: "put" as const,
      key: checkKey(utf("a")),
      value: checkValue(new Uint8Array(10)),
    };
    const second = {
      type: "put" as const,
      key: checkKey(utf("b")),
      value: checkValue(new Uint8Array(4)),
    };
    const seq = await wal.append([first]);
    expect(seq).toBe(1);
    expect(await wal.uningestedBytes()).toBe(opsBytes([first]));
    const next = await wal.append([second]);
    expect(next).toBe(2);
    await wal.advanceIngested(seq ?? 0, 1, opsBytes([first]));
    expect(await wal.uningestedBytes()).toBe(opsBytes([second]));
    expect((await wal.listUningested()).map((record) => record.seq)).toEqual([2]);
    wal.close();
  });

  it("a second request for the same flush publishes nothing new", async () => {
    const fs = new MemoryFs();
    const host = new EngineHost(() => fs);
    const db = await open(host, fs, "a", { maxWalBytes: 1e9 });
    await db.put(utf("a"), utf("1"));
    expect((await host.ingest(NAME, 1)).generation).toBe(1);
    await db.put(utf("b"), utf("2"));
    expect((await host.ingest(NAME, 1)).generation).toBe(1);
    expect((await loadLatestGeneration(fs))?.runs).toHaveLength(1);
    await db.close();
  });

  it("counts overwrites of one key, which leave the memtable the same size", async () => {
    const { fs, a, b } = await twoTabs({ maxWalBytes: 20 });
    await a.put(utf("k"), utf("1".repeat(8)));
    await b.put(utf("k"), utf("2".repeat(8)));
    await settle();
    expect(await loadLatestGeneration(fs)).toBeUndefined();
    await a.put(utf("k"), utf("3".repeat(8)));
    await vi.waitFor(async () => expect((await loadLatestGeneration(fs))?.runs).toHaveLength(1), WAIT);
    await b.sync();
    expect(new TextDecoder().decode(await b.get(utf("k")))).toBe("3".repeat(8));
    await a.close();
    await b.close();
  });

  it("keeps the waiting WAL under the limit plus one batch, for overwrites and deletes", async () => {
    const limit = 4_000;
    const { a, b } = await twoTabs({ maxWalBytes: limit });
    const keys = Array.from({ length: 50 }, (_, i) => utf(`key/${String(i).padStart(4, "0")}`));
    const wal = await IdBWal.open(checkDbName(NAME));
    const waiting = async () => (await wal.tail(0)).records.reduce((n, r) => n + opsBytes(r.ops), 0);
    for (let round = 0; round < 40; round++) {
      await a.batch((tx) => {
        for (const k of keys) {
          if (round % 2) tx.delete(k);
          else tx.put(k, new Uint8Array(40));
        }
      });
      await vi.waitFor(async () => expect(await waiting()).toBeLessThanOrEqual(limit + 50 * 48), WAIT);
    }
    // The last batch starts an ingest. Let it finish before the next test deletes the database.
    await settle();
    wal.close();
    expect(await b.get(keys[0]!)).toBeUndefined();
    await a.close();
    await b.close();
  });

  it("ingests a WAL left over the limit when the database opens again", async () => {
    const fs = new MemoryFs();
    const before = await open(new EngineHost(() => fs), fs, "a", { maxWalBytes: 1e9 });
    await before.put(utf("k"), new Uint8Array(150));
    await before.close();
    await settle();
    expect(await loadLatestGeneration(fs)).toBeUndefined();

    const reloaded = await open(new EngineHost(() => fs), fs, "b", { maxWalBytes: 100 });
    await vi.waitFor(async () => expect((await loadLatestGeneration(fs))?.runs).toHaveLength(1), WAIT);
    expect((await reloaded.get(utf("k")))?.byteLength).toBe(150);
    await reloaded.close();
  });

  it("ingests writes from a tab that closes right after them", async () => {
    const fs = new MemoryFs();
    const host = new EngineHost(() => fs);
    const reader = await open(host, fs, "reader", { maxWalBytes: 100 });
    const seen = ingestEvents(reader);
    const writer = await open(host, fs, "writer", { maxWalBytes: 100 });
    // Let the open's WAL measurement finish, so only the append can trigger.
    await settle();
    await writer.put(utf("k"), new Uint8Array(150));
    await writer.close();
    await vi.waitFor(() => expect(seen).toHaveLength(1), WAIT);
    await reader.sync();
    expect((await reader.get(utf("k")))?.byteLength).toBe(150);
    expect((await loadLatestGeneration(fs))?.runs).toHaveLength(1);
    await reader.close();
  });

  it("runs one ingest at a time and folds what arrived meanwhile into the next", async () => {
    const { fs, state } = l0Fs();
    let release!: () => void;
    state.hold = new Promise<void>((r) => (release = r));
    const db = await open(new EngineHost(() => fs), fs, "a", { maxWalBytes: 100 });
    await db.put(utf("k0"), new Uint8Array(150));
    await vi.waitFor(() => expect(state.started).toBe(1), WAIT);
    for (let i = 1; i <= 4; i++) await db.put(utf(`k${i}`), new Uint8Array(150));
    await settle();
    expect(state.started).toBe(1);

    state.hold = undefined;
    release();
    const wal = await IdBWal.open(checkDbName(NAME));
    await vi.waitFor(async () => expect(await wal.getIngestedThrough()).toBe(5), WAIT);
    wal.close();
    expect(state.started).toBe(2);
    expect(state.maxInFlight).toBe(1);
    await db.close();
  });

  it("logs a failed ingest and retries once another maxWalBytes is waiting", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { fs, state } = l0Fs();
    state.fail = true;
    const db = await open(new EngineHost(() => fs), fs, "a", { maxWalBytes: 100 });
    await db.put(utf("a"), new Uint8Array(120));
    await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(1), WAIT);

    state.fail = false;
    await db.put(utf("b"), new Uint8Array(50));
    await settle();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(await loadLatestGeneration(fs)).toBeUndefined();

    await db.put(utf("c"), new Uint8Array(60));
    await vi.waitFor(async () => expect((await loadLatestGeneration(fs))?.runs).toHaveLength(1), WAIT);
    expect(errors).toHaveBeenCalledTimes(1);
    await db.close();
  });
});

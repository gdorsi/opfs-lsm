import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { type Db } from "../src/index.js";
import {
  openHarnessDb,
  __resetMemoryFsForTests,
  ingest,
  EngineHost,
  MemoryFs,
  createLocalIngestClient,
  type AsyncFs,
  readStats,
} from "../src/testing.js";
import { checkDbName, checkKey, checkValue, opsBytes } from "../src/check.js";
import { IdBWal } from "../src/idb/wal.js";
import { loadLatestGeneration } from "../src/store/generation.js";
import { checkDatabase, deleteWal, walStore } from "./sim/check-database.js";

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

async function open(host: EngineHost, fs: AsyncFs, writerId: string, maxWalBytes: number) {
  const db = await openHarnessDb({
    name: NAME,
    writerId,
    fs,
    maxWalBytes,
    ingest: createLocalIngestClient(host),
  });
  opened.push(db);
  return db;
}

async function twoTabs(maxWalBytes: number) {
  const fs = new MemoryFs();
  const host = new EngineHost(() => fs);
  const a = await open(host, fs, "a", maxWalBytes);
  const b = await open(host, fs, "b", maxWalBytes);
  return { fs, a, b };
}

/** Resolves once the host has published a generation. */
function flushed(fs: AsyncFs): Promise<void> {
  return vi.waitFor(async () => expect(await loadLatestGeneration(fs)).toBeDefined(), WAIT);
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
    const { fs, a, b } = await twoTabs(100);
    await a.put(utf("a"), new Uint8Array(60));
    await settle();
    expect(await loadLatestGeneration(fs)).toBeUndefined();
    await b.put(utf("b"), new Uint8Array(60));
    await b.put(utf("c"), new Uint8Array(1));
    await flushed(fs);
    await settle();
    const gen = await loadLatestGeneration(fs);
    expect(gen?.runs).toHaveLength(1);
    expect((await a.get(utf("c")))?.byteLength).toBe(1);
    await a.close();
    await b.close();
  });

  it("a tab that asked for no flush loads the generation another tab's flush published", async () => {
    const { a, b } = await twoTabs(1e12);
    await a.put(utf("k"), utf("v"));
    const manifestReads = async () => (await readStats(b)).tab.fs.read.m?.calls ?? 0;
    const before = await manifestReads();
    await ingest(a);
    await vi.waitFor(async () => expect(await manifestReads()).toBeGreaterThan(before), WAIT);
  });

  it("a reopened database uses the stored WAL size", async () => {
    const fs = new MemoryFs();
    const host = new EngineHost(() => fs);
    const writer = await open(host, fs, "a", 1 << 30);
    await writer.put(utf("a"), new Uint8Array(40));
    await writer.close();

    const under = await open(host, fs, "b", 100);
    await settle();
    expect(await loadLatestGeneration(fs)).toBeUndefined();
    expect((await under.get(utf("a")))?.byteLength).toBe(40);
    await under.close();

    const more = await open(host, fs, "c", 1 << 30);
    await more.put(utf("b"), new Uint8Array(80));
    await more.close();
    const over = await open(host, fs, "d", 50);
    await vi.waitFor(
      async () => expect((await loadLatestGeneration(fs))?.runs).toHaveLength(1),
      WAIT,
    );
    expect((await over.get(utf("a")))?.byteLength).toBe(40);
    expect((await over.get(utf("b")))?.byteLength).toBe(80);
    await over.close();
  });

  it("measures the WAL from the records above ingestedThrough", async () => {
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
    expect(await wal.uningestedBytes(1 << 30)).toBe(0);
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
    expect(await wal.uningestedBytes(1 << 30)).toBe(opsBytes([first]));
    const next = await wal.append([second]);
    expect(next).toBe(2);
    await wal.advanceIngested(seq ?? 0, 1);
    expect(await wal.uningestedBytes(1 << 30)).toBe(opsBytes([second]));
    expect((await wal.listUningested({ maxBytes: 1 << 30 })).map((record) => record.seq)).toEqual([2]);
    await wal.append([first]);
    const secondBytes = opsBytes([second]);
    const bothBytes = secondBytes + opsBytes([first]);
    expect(await wal.uningestedBytes(1 << 20), "under the cap: exact").toBe(bothBytes);
    // Seq 2 is 5 bytes and seq 3 is 11. A cap of 5 stops after seq 2 with
    // bytes == cap, so it cannot tell a partial sum from the cap itself.
    expect(secondBytes).toBe(5);
    expect(await wal.uningestedBytes(8), "early stop, bytes under the cap").toBe(8);
    expect(await wal.uningestedBytes(4), "early stop, the first record past the cap").toBe(secondBytes);
    expect(bothBytes).toBeGreaterThan(8);
    wal.close();
  });

  it("reports the cap once the total passes it, and the exact total at or under it", async () => {
    const name = `${NAME}-bytes`;
    onTestFinished(() => deleteWal(name));
    const wal = await IdBWal.open(checkDbName(name));
    const op = (n: number) => [
      {
        type: "put" as const,
        key: checkKey(utf("k")),
        value: checkValue(new Uint8Array(n)),
      },
    ];
    const size = (n: number) => opsBytes(op(n));
    await wal.append(op(20));
    await wal.append(op(18));
    await wal.append(op(10));
    const full = size(20) + size(18) + size(10);
    expect(full).toBe(51);
    expect(await wal.uningestedBytes(1 << 30)).toBe(full);
    expect(await wal.uningestedBytes(full + 1), "one over the total: exact").toBe(full);
    expect(await wal.uningestedBytes(full), "exactly the total").toBe(full);
    expect(await wal.uningestedBytes(full - 1), "one under the total: the cap").toBe(full - 1);
    expect(await wal.uningestedBytes(size(20)), "cap on a record boundary, with more left").toBe(size(20));
    const pastFirst = await wal.uningestedBytes(size(20) - 1);
    expect(pastFirst, "a record larger than the cap still says the WAL is over it").toBeGreaterThanOrEqual(size(20) - 1);
    expect(pastFirst).toBeLessThan(full);
    await wal.advanceIngested(1, 1);
    const rest = size(18) + size(10);
    expect(await wal.uningestedBytes(1 << 30), "ingested rows are not counted").toBe(rest);
    expect(await wal.uningestedBytes(rest)).toBe(rest);
    expect(await wal.uningestedBytes(rest - 1)).toBe(rest - 1);
    wal.close();
  });

  it("ingests on open exactly when the waiting WAL reaches maxWalBytes", async () => {
    const limit = 40;
    const key = utf("k");
    // Key "k" is one byte, so a value of n bytes counts as n + 1.
    const cases = [
      { id: "under", values: [30], total: 31, ingests: false },
      { id: "exact", values: [39], total: 40, ingests: true },
      { id: "over", values: [40], total: 41, ingests: true },
      { id: "two-under", values: [20, 17], total: 39, ingests: false },
      { id: "two-exact", values: [20, 18], total: 40, ingests: true },
      // The first record is under the limit. The capped read has to notice the second.
      { id: "two-over", values: [20, 30], total: 52, ingests: true },
    ];
    for (const c of cases) onTestFinished(() => deleteWal(`${NAME}-cap-${c.id}`));
    for (const { id, values, total, ingests } of cases) {
      const name = `${NAME}-cap-${id}`;
      let got = 0;
      for (const n of values) {
        got += opsBytes([{ type: "put", key: checkKey(key), value: checkValue(new Uint8Array(n)) }]);
      }
      expect(got).toBe(total);
      const fs = new MemoryFs();
      const host = new EngineHost(() => fs);
      const writer = await openHarnessDb({
        name,
        writerId: "w",
        fs,
        ingest: createLocalIngestClient(host),
        maxWalBytes: 1 << 30,
      });
      opened.push(writer);
      for (const n of values) await writer.put(key, new Uint8Array(n));
      await writer.close();
      const reader = await openHarnessDb({
        name,
        writerId: "r",
        fs,
        ingest: createLocalIngestClient(host),
        maxWalBytes: limit,
      });
      opened.push(reader);
      if (ingests) {
        await vi.waitFor(async () => expect(await loadLatestGeneration(fs)).toBeDefined(), WAIT);
      } else {
        for (let i = 0; i < 40; i++) {
          expect(await loadLatestGeneration(fs)).toBeUndefined();
          await new Promise((r) => setTimeout(r, 25));
        }
      }
      expect((await reader.get(key))?.byteLength).toBe(values[values.length - 1]);
      await reader.close();
    }
  });

  it("opens a database that still stores meta.pendingBytes", async () => {
    const name = `${NAME}-legacy`;
    onTestFinished(() => deleteWal(name));
    const first = {
      type: "put" as const,
      key: checkKey(utf("a")),
      value: checkValue(utf("1")),
    };
    const second = {
      type: "put" as const,
      key: checkKey(utf("a")),
      value: checkValue(utf("2")),
    };
    const wal = await IdBWal.open(checkDbName(name));
    await wal.append([first]);
    await wal.append([second]);
    await wal.close();
    // An older build wrote `meta.head` on each append and kept `pendingBytes`.
    // The floor is left behind the last key, and the counter is wrong.
    await walStore(name, "readwrite", (_wal, meta) => {
      meta.put(1, "head");
      meta.put(123_456, "pendingBytes");
    });
    const again = await IdBWal.open(checkDbName(name));
    expect((await again.meta()).head).toBe(2);
    expect((await again.tail(0)).records.map((r) => r.seq)).toEqual([1, 2]);
    expect(await again.uningestedBytes(1 << 30)).toBe(opsBytes([first]) + opsBytes([second]));
    again.close();

    const fs = new MemoryFs();
    const host = new EngineHost(() => fs);
    const db = await openHarnessDb({
      name,
      writerId: "a",
      fs,
      ingest: createLocalIngestClient(host),
      maxWalBytes: 1 << 30,
    });
    opened.push(db);
    const dec = new TextDecoder();
    expect(dec.decode(await db.get(utf("a")))).toBe("2");
    await db.put(utf("b"), utf("3"));
    expect(dec.decode(await db.get(utf("b")))).toBe("3");
    await ingest(db);
    await db.close();
    expect((await checkDatabase(fs, name)).problems).toEqual([]);
    const reopened = await openHarnessDb({
      name,
      writerId: "b",
      fs,
      ingest: createLocalIngestClient(host),
      maxWalBytes: 1 << 30,
    });
    opened.push(reopened);
    expect(dec.decode(await reopened.get(utf("a")))).toBe("2");
    expect(dec.decode(await reopened.get(utf("b")))).toBe("3");
    await reopened.close();
  });

  it("flushes asked for together publish one run", async () => {
    const fs = new MemoryFs();
    const host = new EngineHost(() => fs);
    const db = await open(host, fs, "a", 1e9);
    await db.put(utf("a"), utf("1"));
    const flushes = await Promise.all([host.ingest(NAME), host.ingest(NAME)]);
    expect(flushes.map((f) => f.generation)).toEqual([1, 1]);
    expect((await loadLatestGeneration(fs))?.runs).toHaveLength(1);
    await db.close();
  });

  it("counts overwrites of one key, which leave the memtable the same size", async () => {
    const { fs, a, b } = await twoTabs(20);
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
    const { a, b } = await twoTabs(limit);
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
    const before = await open(new EngineHost(() => fs), fs, "a", 1e9);
    await before.put(utf("k"), new Uint8Array(150));
    await before.close();
    await settle();
    expect(await loadLatestGeneration(fs)).toBeUndefined();

    const reloaded = await open(new EngineHost(() => fs), fs, "b", 100);
    await vi.waitFor(async () => expect((await loadLatestGeneration(fs))?.runs).toHaveLength(1), WAIT);
    expect((await reloaded.get(utf("k")))?.byteLength).toBe(150);
    await reloaded.close();
  });

  it("ingests writes from a tab that closes right after them", async () => {
    const fs = new MemoryFs();
    const host = new EngineHost(() => fs);
    const reader = await open(host, fs, "reader", 100);
    const writer = await open(host, fs, "writer", 100);
    // Let the open's WAL measurement finish, so only the append can trigger.
    await settle();
    await writer.put(utf("k"), new Uint8Array(150));
    await writer.close();
    await flushed(fs);
    await reader.sync();
    expect((await reader.get(utf("k")))?.byteLength).toBe(150);
    expect((await loadLatestGeneration(fs))?.runs).toHaveLength(1);
    await reader.close();
  });

  it("runs one ingest at a time and folds what arrived meanwhile into the next", async () => {
    const { fs, state } = l0Fs();
    let release!: () => void;
    state.hold = new Promise<void>((r) => (release = r));
    const db = await open(new EngineHost(() => fs), fs, "a", 100);
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
    const db = await open(new EngineHost(() => fs), fs, "a", 100);
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

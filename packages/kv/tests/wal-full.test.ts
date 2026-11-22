import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StorageFullError, type Db } from "../src/index.js";
import { RESERVE_PATH } from "../src/host/reserve.js";
import {
  attachEngineHostPort,
  createLocalIngestClient,
  createPortIngestClient,
  EngineHost,
  ingest,
  MemoryFs,
  openHarnessDb,
  type IngestClient,
} from "../src/testing.js";
import { BudgetFs, refuseWalAppends } from "./sim/byte-budget.js";

const KiB = 1024;
const RESERVE = 64 * KiB;
const enc = new TextEncoder();
const dec = new TextDecoder();
const utf = (s: string) => enc.encode(s);

let name: string;
let fs: MemoryFs;
let budget: BudgetFs;
let host: EngineHost;
let restore: () => void;
let dbCount = 0;
const opened: Db[] = [];

beforeEach(() => {
  name = `wal-full-${++dbCount}`;
  fs = new MemoryFs();
  budget = new BudgetFs(fs, 1024 * KiB);
  host = hostOf(budget);
  restore = refuseWalAppends(name, budget);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  // A flush that the full origin refuses in the background logs.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const db of opened.splice(0)) await db.close();
  restore();
  vi.restoreAllMocks();
});

/** A host on `folder` itself: a flush can outlive its test, and must not reach the next one's folder. */
function hostOf(folder: BudgetFs): EngineHost {
  return new EngineHost(() => folder);
}

async function open(reserveBytes = RESERVE, client: IngestClient = createLocalIngestClient(host)): Promise<Db> {
  const db = await openHarnessDb({ name, fs, ingest: client, maxWalBytes: 1 << 30, reserveBytes });
  opened.push(db);
  return db;
}

/** A database with a row flushed, so the first pass has ended and the reserve is on disk when one is asked for. */
async function openFlushed(reserveBytes = RESERVE, client?: IngestClient): Promise<Db> {
  const db = await open(reserveBytes, client);
  await db.put(utf("first"), utf("row"));
  await ingest(db);
  expect(budget.sizeOf(RESERVE_PATH)).toBe(reserveBytes);
  return db;
}

/** The origin has no byte left. */
function fillOrigin(): void {
  budget.limit = budget.used;
}

async function read(db: Db, key: string): Promise<string | undefined> {
  const value = await db.get(utf(key));
  return value && dec.decode(value);
}

/** The seqs in the WAL database, as IndexedDB holds them. */
function walSeqs(): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(`opfs-lsm-wal/${name}`);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const keys = req.result.transaction("wal").objectStore("wal").getAllKeys();
      keys.onsuccess = () => {
        req.result.close();
        resolve(keys.result as number[]);
      };
    };
  });
}

describe("the seam that refuses WAL appends", () => {
  it("refuses the way a browser does: the request succeeds, then the transaction aborts with QuotaExceededError", async () => {
    const db = await open(0);
    fillOrigin();
    const events: string[] = [];
    const error = await new Promise<DOMException | null>((resolve, reject) => {
      const req = indexedDB.open(`opfs-lsm-wal/${name}`);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const tx = req.result.transaction("wal", "readwrite");
        const add = tx.objectStore("wal").add(new ArrayBuffer(8));
        add.onsuccess = () => events.push(`request success, key ${String(add.result)}`);
        add.onerror = () => events.push("request error");
        tx.oncomplete = () => events.push("complete");
        tx.onabort = () => {
          events.push("abort");
          req.result.close();
          resolve(tx.error);
        };
        tx.commit();
      };
    });
    expect(events).toEqual(["request success, key 1", "abort"]);
    expect(error?.name).toBe("QuotaExceededError");
    expect(await walSeqs()).toEqual([]);

    budget.limit += KiB;
    expect(await db.put(utf("k"), utf("v"))).toBe(1);
  });

  it("reverts the key generator that an explicit key moved, as IndexedDB does when it aborts a transaction", async () => {
    const db = await open(0);
    fillOrigin();
    const error = await new Promise<DOMException | null>((resolve, reject) => {
      const req = indexedDB.open(`opfs-lsm-wal/${name}`);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const tx = req.result.transaction("wal", "readwrite");
        tx.objectStore("wal").add(new ArrayBuffer(8), 5);
        tx.onabort = () => {
          req.result.close();
          resolve(tx.error);
        };
        tx.commit();
      };
    });
    expect(error?.name).toBe("QuotaExceededError");

    budget.limit += KiB;
    expect(await db.put(utf("k"), utf("v"))).toBe(1);
  });
});

describe("a WAL append the browser refuses", () => {
  it("lands after the host released the reserve, and the handler is offered", async () => {
    const db = await openFlushed();
    const offers: unknown[] = [];
    db.onStorageFull(async (full) => void offers.push(full));
    fillOrigin();

    expect(await db.put(utf("k"), utf("v"))).toBe(2);
    expect(budget.sizeOf(RESERVE_PATH)).toBe(0);
    expect(await read(db, "k")).toBe("v");
    expect(await walSeqs()).toEqual([1, 2]);
    await vi.waitFor(() => expect(offers).toHaveLength(1));
    expect(offers[0]).toMatchObject({ need: RESERVE });
  });

  it("rejects with StorageFullError once the reserve is spent, and leaves no record and no gap", async () => {
    const db = await openFlushed();
    fillOrigin();
    await db.put(utf("k"), utf("v"));
    fillOrigin();

    const err = await db.put(utf("lost"), utf("v")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageFullError);
    expect((err as StorageFullError).code).toBe("quota");
    expect(((err as Error).cause as Error).name).toBe("QuotaExceededError");
    expect(await read(db, "lost")).toBeUndefined();
    expect(await walSeqs()).toEqual([1, 2]);

    budget.limit += KiB;
    expect(await db.put(utf("next"), utf("v"))).toBe(3);
    expect(await read(db, "next")).toBe("v");
  });

  it("shares one release among the appends refused together, and keeps the order they were issued in", async () => {
    const db = await openFlushed();
    const makeRoom = vi.spyOn(host, "makeRoom");
    fillOrigin();

    const a = db.put(utf("a"), utf("1"));
    const b = db.put(utf("b"), utf("2"));
    const sum = db.update([utf("first")], ([row], tx) => {
      tx.put(utf("c"), row!);
      return dec.decode(row!);
    });
    // Issued while the refused group waits for its room.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const late = db.put(utf("d"), utf("4"));

    const seqs = await Promise.all([a, b, late]);
    expect(await sum).toBe("row");
    expect(seqs[0]).toBeLessThan(seqs[1]!);
    expect(seqs[1]).toBeLessThan(seqs[2]!);
    expect(makeRoom).toHaveBeenCalledTimes(1);
    expect(await walSeqs()).toEqual([1, 2, 3, 4, 5]);
    expect([await read(db, "a"), await read(db, "b"), await read(db, "c"), await read(db, "d")]).toEqual(["1", "2", "row", "4"]);
  });

  it("lands a refused update after the host released the reserve, without running its body again", async () => {
    const db = await openFlushed();
    fillOrigin();
    let runs = 0;
    const result = await db.update([utf("first")], ([row], tx) => {
      runs += 1;
      tx.put(utf("copy"), row!);
      return runs;
    });
    expect(result).toBe(1);
    expect(await read(db, "copy")).toBe("row");
    expect(await walSeqs()).toEqual([1, 2]);

    fillOrigin();
    await expect(db.update([utf("first")], (_, tx) => tx.put(utf("lost"), utf("v")))).rejects.toBeInstanceOf(StorageFullError);
    expect(await read(db, "lost")).toBeUndefined();
    expect(await walSeqs()).toEqual([1, 2]);
  });

  it("runs the body of an update again when the browser refuses its transaction, and only its last run counts", async () => {
    const db = await openFlushed();
    const release = host.makeRoom.bind(host);
    let go!: () => void;
    const held = new Promise<void>((resolve) => (go = resolve));
    vi.spyOn(host, "makeRoom").mockImplementation(async (n) => {
      await held;
      await release(n);
    });
    fillOrigin();
    let runs = 0;
    let seen: string | undefined;
    // With a put of this handle in flight, the update writes in a transaction of its own.
    const put = db.put(utf("first"), utf("new"));
    const update = db.update([utf("first")], ([row], tx) => {
      runs += 1;
      seen = dec.decode(row!);
      tx.put(utf("copy"), row!);
      return runs;
    });
    await vi.waitFor(() => expect(runs).toBe(1));
    go();
    await put;
    expect(await update).toBe(2);
    expect(await read(db, "copy")).toBe(seen);
  });

  it("holds the writes issued while it recovers, and lands them after it", async () => {
    const db = await openFlushed();
    const release = host.makeRoom.bind(host);
    let asked!: () => void;
    const recovering = new Promise<void>((resolve) => (asked = resolve));
    let go!: () => void;
    const held = new Promise<void>((resolve) => (go = resolve));
    const makeRoom = vi.spyOn(host, "makeRoom").mockImplementation(async (n) => {
      asked();
      await held;
      await release(n);
    });
    fillOrigin();

    const refused = db.update([utf("first")], (_, tx) => tx.put(utf("a"), utf("1")));
    await recovering;
    const put = db.put(utf("b"), utf("2"));
    const update = db.update([utf("first")], (_, tx) => tx.put(utf("c"), utf("3")));
    go();

    await Promise.all([refused, put, update]);
    expect(makeRoom).toHaveBeenCalledTimes(1);
    expect(await walSeqs()).toEqual([1, 2, 3, 4]);
    expect([await read(db, "a"), await read(db, "b"), await read(db, "c")]).toEqual(["1", "2", "3"]);
  });

  it("holds the writes issued while an update's own transaction recovers, and lands them", async () => {
    const a = await openFlushed();
    const b = await open();
    // b's put takes the seq a's update row names, so a's updates run in a transaction of their own from here.
    await a.update([utf("first")], (_, tx) => {
      void b.put(utf("b"), utf("2"));
      tx.put(utf("a"), utf("1"));
    });
    const release = host.makeRoom.bind(host);
    let asked!: () => void;
    const recovering = new Promise<void>((resolve) => (asked = resolve));
    let go!: () => void;
    const held = new Promise<void>((resolve) => (go = resolve));
    const makeRoom = vi.spyOn(host, "makeRoom").mockImplementation(async (n) => {
      asked();
      await held;
      await release(n);
    });
    fillOrigin();

    const refused = a.update([utf("first")], (_, tx) => tx.put(utf("c"), utf("3")));
    await recovering;
    const put = a.put(utf("d"), utf("4"));
    go();

    await Promise.all([refused, put]);
    expect(makeRoom).toHaveBeenCalledTimes(1);
    expect([await read(a, "a"), await read(a, "c"), await read(a, "d")]).toEqual(["1", "3", "4"]);
  });

  it("lands in two handles refused in the same turn, with one release", async () => {
    const a = await openFlushed();
    const b = await open();
    fillOrigin();
    await Promise.all([a.put(utf("a"), utf("1")), b.put(utf("b"), utf("2"))]);
    await a.sync();
    expect([await read(a, "a"), await read(a, "b")]).toEqual(["1", "2"]);
    expect(budget.sizeOf(RESERVE_PATH)).toBe(0);
  });

  it("lands when the reserve is one an earlier session left and this host has not looked yet", async () => {
    await (await openFlushed()).close();
    opened.length = 0;
    host = hostOf(budget);
    const db = await open();
    fillOrigin();

    expect(await db.put(utf("k"), utf("v"))).toBe(2);
    expect(budget.sizeOf(RESERVE_PATH)).toBe(0);
  });

  it("lands when the host is behind a MessagePort", async () => {
    const { port1, port2 } = new MessageChannel();
    attachEngineHostPort(port1, host);
    const client = createPortIngestClient(port2);
    try {
      const db = await openFlushed(RESERVE, client);
      fillOrigin();
      expect(await db.put(utf("k"), utf("v"))).toBe(2);
      expect(budget.sizeOf(RESERVE_PATH)).toBe(0);
    } finally {
      for (const db of opened.splice(0)) await db.close();
      client.close();
      port1.close();
      port2.close();
    }
  });

  it("rejects with StorageFullError, and calls no handler, when no handle asks for a reserve", async () => {
    const db = await openFlushed(0);
    let calls = 0;
    db.onStorageFull(async () => void calls++);
    fillOrigin();
    await expect(db.put(utf("k"), utf("v"))).rejects.toBeInstanceOf(StorageFullError);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls).toBe(0);
    expect(await walSeqs()).toEqual([1]);
  });
});

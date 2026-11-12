import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConstraintError, type Db, type Pressure } from "../src/index.js";
import { createLocalIngestClient, EngineHost, ingest, MemoryFs, openHarnessDb } from "../src/testing.js";

const KiB = 1024;
const enc = new TextEncoder();
const VALUE = 1000;
const keyOf = (i: number) => enc.encode(`k${String(i).padStart(6, "0")}`);
const entryBytes = (i: number) => keyOf(i).byteLength + VALUE;

let name: string;
let fs: MemoryFs;
let host: EngineHost;
let dbCount = 0;
const opened: Db[] = [];

function wipe(db: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${db}`);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  name = `max-bytes-${++dbCount}`;
  await wipe(name);
  fs = new MemoryFs();
  host = new EngineHost(() => fs, { minMaxBytes: 1 });
});

afterEach(async () => {
  for (const db of opened.splice(0)) await db.close();
  await host.opened();
  vi.restoreAllMocks();
});

async function open(options: { tab?: string; maxBytes?: number } = {}): Promise<Db> {
  const db = await openHarnessDb({ name, fs, ingest: createLocalIngestClient(host), maxWalBytes: 1 << 30, ...options });
  opened.push(db);
  return db;
}

/** Seq of the last write of each live key: the oracle. */
type Model = Map<number, number>;

async function fill(db: Db, model: Model, from: number, count: number): Promise<void> {
  for (let i = from; i < from + count; i += 50) {
    const seq = await db.batch((tx) => {
      for (let j = i; j < Math.min(i + 50, from + count); j++) tx.put(keyOf(j), new Uint8Array(VALUE).fill(j % 251));
    });
    for (let j = i; j < Math.min(i + 50, from + count); j++) model.set(j, seq);
  }
}

const liveOf = (model: Model) => [...model.keys()].reduce((n, i) => n + entryBytes(i), 0);
const liveThrough = (model: Model, seq: number) =>
  [...model].reduce((n, [i, at]) => (at <= seq ? n + entryBytes(i) : n), 0);

async function readAll(db: Db): Promise<number[]> {
  const out: number[] = [];
  for await (const e of db.range()) out.push(Number(new TextDecoder().decode(e.key).slice(1)));
  return out;
}

/** Waits a few host turns: long enough for a broadcast, a lock grant and a handler to run. */
const turns = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await turns(10);
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
}

/** A promise and its resolver. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

describe("maxBytes", () => {
  it("refuses onPressure on a handle opened without maxBytes, and a maxBytes that is not a positive integer", async () => {
    const db = await open();
    expect(() => db.onPressure(async () => {})).toThrow(ConstraintError);
    await expect(open({ maxBytes: 0 })).rejects.toThrow(ConstraintError);
    await expect(open({ maxBytes: 1.5 })).rejects.toThrow(ConstraintError);
  });

  it("makes no offer while the live bytes are under the cap", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = await open({ maxBytes: 200 * KiB });
    const calls: Pressure[] = [];
    db.onPressure(async (p) => void calls.push(p));
    const quiet = await open({ maxBytes: 200 * KiB, tab: "b" });
    await fill(db, new Map(), 0, 150);
    await ingest(db);
    await turns();
    expect(calls).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    void quiet;
  });

  it("offers numbers that match the oracle within the estimate's bound", async () => {
    const db = await open({ maxBytes: 100 * KiB });
    const calls: Pressure[] = [];
    db.onPressure(async (p) => void calls.push(p));
    const model: Model = new Map();
    await fill(db, model, 0, 100);
    await ingest(db);
    await fill(db, model, 100, 100);
    for (let i = 0; i < 40; i += 2) {
      await db.delete(keyOf(i));
      model.delete(i);
    }
    await ingest(db);
    await until(() => calls.length === 1, "one offer");
    const [p] = calls;
    const live = liveOf(model);
    expect(Math.abs(p!.liveBytes - live)).toBeLessThanOrEqual(live / 16);
    expect(p!.maxBytes).toBe(100 * KiB);
    expect(p!.need).toBe(Math.ceil(p!.liveBytes - (100 * KiB * 7) / 8));
    const freed = liveThrough(model, p!.through);
    expect(Math.abs(freed - p!.need)).toBeLessThanOrEqual(live / 8);
  });

  it("an oldest-first handler brings the live bytes under the cap, and reads agree with the oracle", async () => {
    const db = await open({ maxBytes: 100 * KiB });
    const model: Model = new Map();
    const calls: Pressure[] = [];
    db.onPressure(async (p) => {
      calls.push(p);
      await db.batch((tx) => tx.deleteRange({}, { through: p.through }));
      for (const [i, at] of model) if (at <= p.through) model.delete(i);
    });
    await fill(db, model, 0, 250);
    await ingest(db);
    await until(() => calls.length === 1, "one offer");
    await turns();
    await ingest(db);
    await turns();
    expect(calls.length).toBe(1);
    expect(liveOf(model)).toBeLessThanOrEqual(100 * KiB);
    expect(await readAll(db)).toEqual([...model.keys()].sort((a, b) => a - b));
    const other = await open({ tab: "b" });
    expect(await readAll(other)).toEqual([...model.keys()].sort((a, b) => a - b));
  });

  it("a handler that deletes rows of its choice is not asked again for the bytes its deletes hide", async () => {
    const db = await open({ maxBytes: 100 * KiB });
    const model: Model = new Map();
    const calls: Pressure[] = [];
    db.onPressure(async (p) => {
      calls.push(p);
      let freed = 0;
      for (const i of [...model.keys()].filter((k) => k % 2 === 1)) {
        if (freed >= p.need) break;
        await db.delete(keyOf(i));
        model.delete(i);
        freed += entryBytes(i);
      }
    });
    await fill(db, model, 0, 200);
    await ingest(db);
    await until(() => calls.length === 1, "one offer");
    await turns();
    await ingest(db);
    await turns();
    expect(calls.length).toBe(1);
    expect(liveOf(model)).toBeLessThanOrEqual(100 * KiB);
    expect(await readAll(db)).toEqual([...model.keys()].sort((a, b) => a - b));
  });

  it("calls one tab's handlers once per offer, every handler of that tab, none of another tab", async () => {
    const a1 = await open({ maxBytes: 100 * KiB, tab: "a" });
    const a2 = await open({ maxBytes: 100 * KiB, tab: "a" });
    const b = await open({ maxBytes: 100 * KiB, tab: "b" });
    const calls: string[] = [];
    a1.onPressure(async () => void calls.push("a1"));
    await turns();
    a2.onPressure(async () => void calls.push("a2"));
    b.onPressure(async () => void calls.push("b"));
    await fill(a1, new Map(), 0, 150);
    await ingest(a1);
    await until(() => calls.length >= 2, "the holder tab's handlers");
    await turns(100);
    expect(calls).toEqual(["a1", "a2"]);
  });

  it("warns once per offer when no tab has a handler, and not when another tab answers", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = await open({ maxBytes: 100 * KiB });
    await open({ maxBytes: 100 * KiB });
    await fill(db, new Map(), 0, 150);
    await ingest(db);
    await until(() => warn.mock.calls.length > 0, "a warning");
    await host.compact(name);
    await turns();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/over maxBytes .* no tab registered an onPressure handler/);

    warn.mockClear();
    const answers = await open({ maxBytes: 100 * KiB, tab: "b" });
    const calls: Pressure[] = [];
    answers.onPressure(async (p) => void calls.push(p));
    await until(() => calls.length === 1, "the new handler pulls the open offer");
    await fill(db, new Map(), 150, 50);
    await ingest(db);
    await until(() => calls.length === 2, "a second offer");
    await turns();
    expect(warn).not.toHaveBeenCalled();
  });

  it("gives the open offer to another tab when the answering handle closes mid-handler", async () => {
    const a = await open({ maxBytes: 100 * KiB, tab: "a" });
    const b = await open({ maxBytes: 100 * KiB, tab: "b" });
    const started = gate();
    const seen: { tab: string; pressure: Pressure }[] = [];
    a.onPressure(async (pressure) => {
      seen.push({ tab: "a", pressure });
      started.open();
      await new Promise(() => undefined);
    });
    await turns();
    b.onPressure(async (pressure) => void seen.push({ tab: "b", pressure }));
    await fill(b, new Map(), 0, 150);
    await ingest(b);
    await started.promise;
    await a.close();
    await until(() => seen.length === 2, "tab b gets the offer");
    expect(seen.map((s) => s.tab)).toEqual(["a", "b"]);
    expect(seen[1]!.pressure).toEqual(seen[0]!.pressure);
  });

  it("offers again after a handler throws, at the next compaction pass and not before", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = await open({ maxBytes: 100 * KiB });
    let calls = 0;
    db.onPressure(async () => {
      calls += 1;
      throw new Error("no luck");
    });
    const model: Model = new Map();
    await fill(db, model, 0, 150);
    await ingest(db);
    await until(() => calls === 1, "the first offer");
    await turns(100);
    expect(calls).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/onPressure handler/), expect.any(Error));
    await host.compact(name);
    await until(() => calls === 2, "a second offer after the next pass");
    await turns(100);
    expect(calls).toBe(2);
  });

  it("waits for a flush that holds the handler's writes before it offers again", async () => {
    const db = await open({ maxBytes: 100 * KiB });
    const calls: Pressure[] = [];
    db.onPressure(async (p) => {
      calls.push(p);
      await db.delete(keyOf(0));
    });
    await fill(db, new Map(), 0, 150);
    await ingest(db);
    await until(() => calls.length === 1, "the first offer");
    await turns();
    await host.compact(name);
    await turns();
    expect(calls.length).toBe(1);
    await ingest(db);
    await until(() => calls.length === 2, "an offer once the delete is flushed and still too little");
    expect(calls[1]!.liveBytes).toBeLessThan(calls[0]!.liveBytes);
  });

  it("stops calling a handler unsubscribed during a run", async () => {
    const db = await open({ maxBytes: 100 * KiB });
    const calls: string[] = [];
    let stopSecond = () => {};
    db.onPressure(async () => {
      calls.push("first");
      stopSecond();
    });
    stopSecond = db.onPressure(async () => void calls.push("second"));
    await fill(db, new Map(), 0, 150);
    await ingest(db);
    await until(() => calls.length === 1, "the first handler");
    await turns();
    expect(calls).toEqual(["first"]);
  });

  it("holds the smallest maxBytes any open tab passed", async () => {
    const a = await open({ maxBytes: 300 * KiB });
    await open({ maxBytes: 100 * KiB, tab: "b" });
    const calls: Pressure[] = [];
    a.onPressure(async (p) => void calls.push(p));
    await fill(a, new Map(), 0, 150);
    await ingest(a);
    await until(() => calls.length === 1, "an offer");
    expect(calls[0]!.maxBytes).toBe(100 * KiB);
  });

  it("never holds a write for the cap", async () => {
    const db = await open({ maxBytes: 100 * KiB });
    const started = gate();
    db.onPressure(async () => {
      started.open();
      await new Promise(() => undefined);
    });
    const model: Model = new Map();
    await fill(db, model, 0, 150);
    await ingest(db);
    await started.promise;
    await fill(db, model, 150, 150);
    await ingest(db);
    expect(await readAll(db)).toEqual([...model.keys()].sort((a, b) => a - b));
  });

  it("a new host measures the manifest again and offers", async () => {
    const db = await open({ maxBytes: 100 * KiB });
    const calls: Pressure[] = [];
    db.onPressure(async (p) => void calls.push(p));
    await fill(db, new Map(), 0, 150);
    await ingest(db);
    await until(() => calls.length === 1, "an offer");
    await db.close();
    host = new EngineHost(() => fs, { minMaxBytes: 1 });
    const again = await open({ maxBytes: 100 * KiB });
    again.onPressure(async (p) => void calls.push(p));
    await until(() => calls.length === 2, "the new host offers");
    expect(calls[1]!.liveBytes).toBe(calls[0]!.liveBytes);
  });
});

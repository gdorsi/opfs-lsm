import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConstraintError, type Db, type Pressure } from "../src/index.js";
import { loadLatestGeneration } from "../src/store/generation.js";
import { createLocalIngestClient, EngineHost, ingest, MemoryFs, openHarnessDb, settle } from "../src/testing.js";

const KiB = 1024;
const CAP = 200 * KiB;
const VALUE = 1000;
const enc = new TextEncoder();
const keyOf = (i: number) => enc.encode(`k${String(i).padStart(6, "0")}`);

let name: string;
let fs: MemoryFs;
let host: EngineHost;
let dbCount = 0;
const opened: Db[] = [];

beforeEach(() => {
  name = `max-bytes-${++dbCount}`;
  fs = new MemoryFs();
  host = new EngineHost(() => fs);
});

afterEach(async () => {
  for (const db of opened.splice(0)) await db.close();
  vi.restoreAllMocks();
});

async function open(maxBytes?: number): Promise<Db> {
  const db = await openHarnessDb({ name, fs, ingest: createLocalIngestClient(host), maxWalBytes: 1 << 30, maxBytes });
  opened.push(db);
  return db;
}

/** Puts keys `from..to` with values that do not compress, and flushes them. */
async function fill(db: Db, model: Set<number>, from: number, to: number): Promise<void> {
  for (let i = from; i < to; i += 50) {
    await db.batch((tx) => {
      for (let j = i; j < Math.min(i + 50, to); j++) tx.put(keyOf(j), crypto.getRandomValues(new Uint8Array(VALUE)));
    });
    for (let j = i; j < Math.min(i + 50, to); j++) model.add(j);
  }
  await ingest(db);
}

async function runBytes(): Promise<number> {
  return ((await loadLatestGeneration(fs))?.runs ?? []).reduce((n, run) => n + run.bytes, 0);
}

async function readAll(db: Db): Promise<number[]> {
  await db.sync();
  const out: number[] = [];
  for await (const e of db.range()) out.push(Number(new TextDecoder().decode(e.key).slice(1)));
  return out;
}

const sorted = (model: Set<number>) => [...model].sort((a, b) => a - b);
const turns = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 300 && !cond(); i++) await turns(10);
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
}

/** A handler that range-deletes the oldest keys, about `need` bytes of them. */
function oldestFirst(db: Db, model: Set<number>, calls: Pressure[], measured: number[]) {
  return async (p: Pressure) => {
    calls.push(p);
    measured.push(await runBytes());
    const doomed = sorted(model).slice(0, Math.ceil(p.need / VALUE));
    await db.batch((tx) => tx.deleteRange({ start: keyOf(doomed[0]!), endExclusive: keyOf(doomed.at(-1)! + 1) }));
    for (const i of doomed) model.delete(i);
  };
}

describe("maxBytes", () => {
  it("rejects a maxBytes that is not positive", async () => {
    for (const bad of [0, -1, NaN]) await expect(open(bad)).rejects.toThrow(ConstraintError);
  });

  it("calls one handle's handler once per offer, with the manifest's bytes, and its range delete brings the bytes under the cap", async () => {
    const a = await open(CAP);
    const b = await open(CAP);
    const model = new Set<number>();
    const calls: Pressure[] = [];
    const measured: number[] = [];
    a.onPressure(oldestFirst(a, model, calls, measured));
    b.onPressure(oldestFirst(b, model, calls, measured));
    await fill(a, model, 0, 150);
    await turns();
    expect(calls).toEqual([]);

    await fill(a, model, 150, 300);
    await until(() => calls.length === 1, "one offer");
    const [p] = calls;
    expect(p).toEqual({ bytes: measured[0], maxBytes: CAP, need: measured[0]! - (CAP * 4) / 5 });
    await turns();
    await host.compact(name);
    expect(calls.length).toBe(1);
    await settle(a);
    await turns();
    expect(calls.length).toBe(1);
    expect(await runBytes()).toBeLessThanOrEqual(CAP);
    expect(await readAll(a)).toEqual(sorted(model));
    expect(await readAll(b)).toEqual(sorted(model));
  });

  it("warns once per offer from each handle with no handler, and not once a handle answers; the smallest maxBytes wins", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const a = await open(4 * CAP);
    await open(CAP);
    await open();
    await fill(a, new Set(), 0, 300);
    await until(() => warn.mock.calls.length === 2, "a warning from each capped handle");
    await host.compact(name);
    await turns();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]![0])).toMatch(`over maxBytes ${CAP}`);

    const calls: Pressure[] = [];
    a.onPressure(async (p) => void calls.push(p));
    await until(() => calls.length === 1, "the new handler pulls the open offer");
    expect(calls[0]!.maxBytes).toBe(CAP);
    await fill(a, new Set(), 300, 350);
    await until(() => calls.length === 2, "a second offer");
    await turns();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("does not answer on a lock grant that lands after its handler unsubscribed", async () => {
    const a = await open(CAP);
    const b = await open(CAP);
    const model = new Set<number>();
    const calls: Pressure[] = [];
    let strays = 0;
    a.onPressure(oldestFirst(a, model, calls, []));
    // A grant already on its way when the request aborts: the callback still runs.
    let granted: Promise<unknown> | undefined;
    vi.spyOn(navigator.locks, "request").mockImplementationOnce((...args: unknown[]) => {
      const run = args.at(-1) as (lock: Lock | null) => unknown;
      return (granted = Promise.resolve().then(() => run(null)));
    });
    b.onPressure(() => void strays++)();
    await granted;
    b.onPressure(() => void strays++);

    await fill(a, model, 0, 300);
    await until(() => calls.length === 1, "one offer");
    await turns();
    expect(strays).toBe(0);
  });

  it("gives the open offer to another handle when the answering one closes mid-handler, and never holds a write", async () => {
    const a = await open(CAP);
    const b = await open(CAP);
    const model = new Set<number>();
    let started!: () => void;
    const inHandler = new Promise<void>((resolve) => (started = resolve));
    a.onPressure(async () => {
      started();
      await new Promise(() => undefined);
    });
    await turns();
    const calls: Pressure[] = [];
    b.onPressure(oldestFirst(b, model, calls, []));
    await fill(b, model, 0, 300);
    await inHandler;
    await fill(b, model, 300, 310);
    expect(calls).toEqual([]);
    await a.close();
    await until(() => calls.length === 1, "b gets the offer");
    await settle(b);
    expect(await runBytes()).toBeLessThanOrEqual(CAP);
    expect(await readAll(b)).toEqual(sorted(model));
  });

  it("offers again after a handler throws only at a later compaction pass, and a new host measures again", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let calls = 0;
    const failing = async () => {
      calls += 1;
      throw new Error("no luck");
    };
    const db = await open(CAP);
    db.onPressure(failing);
    await fill(db, new Set(), 0, 300);
    await until(() => calls === 1, "the first offer");
    await turns(200);
    expect(calls).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/onPressure handler/), expect.any(Error));
    await host.compact(name);
    await until(() => calls === 2, "a second offer after the next pass");
    await db.close();
    host = new EngineHost(() => fs);
    (await open(CAP)).onPressure(failing);
    await until(() => calls === 3, "the new host's offer, with no write");
  });
});

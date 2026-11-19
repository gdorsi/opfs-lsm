import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/index.js";
import { createLocalIngestClient, EngineHost, ingest, MemoryFs, openHarnessDb } from "../src/testing.js";
import { loadLatestGeneration } from "./latest-generation.js";
import { BudgetFs } from "./sim/byte-budget.js";

const MiB = 1024 * 1024;
const BUDGET = 12 * MiB;
const VALUE = 1000;
const BATCH = 256;
const enc = new TextEncoder();
const keyOf = (i: number) => enc.encode(`k${String(i).padStart(8, "0")}`);

/** Bytes that do not compress, the same on every run. */
function noise(seed: number): Uint8Array {
  const words = new Uint32Array(VALUE / 4);
  let x = seed | 1;
  for (let i = 0; i < words.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    words[i] = x;
  }
  return new Uint8Array(words.buffer);
}

let name: string;
let fs: MemoryFs;
let budget: BudgetFs;
let host: EngineHost;
let dbCount = 0;
const opened: Db[] = [];

beforeEach(() => {
  name = `reserve-${++dbCount}`;
  fs = new MemoryFs();
  budget = new BudgetFs(fs, BUDGET);
  host = new EngineHost(() => budget);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const db of opened.splice(0)) await db.close();
  vi.restoreAllMocks();
});

async function open(): Promise<Db> {
  const db = await openHarnessDb({ name, fs, ingest: createLocalIngestClient(host), maxWalBytes: 1 << 30 });
  opened.push(db);
  return db;
}

/** Puts time-ordered rows and flushes after each batch, until the browser refuses a write. Returns the rows put. */
async function fillToRefusal(db: Db): Promise<number> {
  let rows = 0;
  while (budget.refused === 0) {
    await db.batch((tx) => {
      for (let i = rows; i < rows + BATCH; i++) tx.put(keyOf(i), noise(i));
    });
    rows += BATCH;
    await ingest(db).catch(() => undefined);
  }
  return rows;
}

async function runBytes(): Promise<number> {
  return ((await loadLatestGeneration(fs))?.runs ?? []).reduce((n, run) => n + run.bytes, 0);
}

describe("a full origin", () => {
  // A delete is a write: its bytes leave the disk only after a flush and a compaction, and both write first.
  it.fails("frees space after a range delete of half the rows of a time-ordered database", async () => {
    const db = await open();
    const rows = await fillToRefusal(db);
    const atFull = await runBytes();

    await db.batch((tx) => tx.deleteRange({ start: keyOf(0), endExclusive: keyOf(rows / 2) }));
    await ingest(db);
    expect(await runBytes()).toBeLessThan(atFull);
  }, 60_000);
});

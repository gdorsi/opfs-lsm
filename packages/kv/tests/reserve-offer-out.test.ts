import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/index.js";
import { RESERVE_PATH } from "../src/host/reserve.js";
import { createLocalIngestClient, EngineHost, ingest, MemoryFs, openHarnessDb } from "../src/testing.js";
import { BudgetFs } from "./sim/byte-budget.js";

/**
 * docs/reserve.md, States: "any | the last tab closes the database |
 * unknown". A session that ends while an offer is out leaves nothing behind
 * in the host: the next session's first pass writes the reserve again.
 */
const MiB = 1024 * 1024;
const BUDGET = 12 * MiB;
const RESERVE = 4 * MiB;
const enc = new TextEncoder();

let name: string;
let fs: MemoryFs;
let budget: BudgetFs;
let host: EngineHost;
let n = 0;
const opened: Db[] = [];

beforeEach(() => {
  name = `reserve-offer-out-${++n}`;
  fs = new MemoryFs();
  budget = new BudgetFs(fs, BUDGET);
  host = new EngineHost(() => budget);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const db of opened.splice(0)) await db.close();
  vi.restoreAllMocks();
});

async function open(): Promise<Db> {
  const db = await openHarnessDb({ name, fs, ingest: createLocalIngestClient(host), maxWalBytes: 1 << 30, reserveBytes: RESERVE });
  opened.push(db);
  return db;
}

async function flushOne(db: Db, i: number): Promise<void> {
  await db.put(enc.encode(`k${i}`), enc.encode("v"));
  await ingest(db);
}

const turns = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the reserve after the last tab closes", () => {
  it("is written by the next session's first pass, though the last session closed with an offer out", async () => {
    // The reserve never fits: the first pass's fill is refused, and the host offers.
    budget.limit = RESERVE / 2;
    const a = await open();
    let offered!: () => void;
    const inHandler = new Promise<void>((resolve) => (offered = resolve));
    // A handler that never settles, so no `full-done` answers the offer.
    a.onStorageFull(() => {
      offered();
      return new Promise(() => undefined);
    });
    await turns(50);
    await flushOne(a, 0);
    await inHandler;
    expect(budget.sizeOf(RESERVE_PATH)).toBe(0);

    // The last tab closes with the offer out, then space frees elsewhere.
    await a.close();
    opened.splice(opened.indexOf(a), 1);
    budget.limit = BUDGET;

    // A new session, with no handler: its first pass writes the reserve.
    const b = await open();
    await flushOne(b, 1);
    expect(budget.sizeOf(RESERVE_PATH)).toBe(RESERVE);
  });
});

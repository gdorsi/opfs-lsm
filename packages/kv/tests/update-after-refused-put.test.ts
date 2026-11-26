import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/index.js";
import { RESERVE_PATH } from "../src/host/reserve.js";
import { createLocalIngestClient, EngineHost, ingest, MemoryFs, openHarnessDb } from "../src/testing.js";
import { BudgetFs, refuseWalAppends } from "./sim/byte-budget.js";

const KiB = 1024;
const RESERVE = 64 * KiB;
const enc = new TextEncoder();
const dec = new TextDecoder();
const utf = (s: string) => enc.encode(s);
const text = (b: Uint8Array | undefined) => (b ? dec.decode(b) : undefined);

let name: string;
let budget: BudgetFs;
let host: EngineHost;
let restore: () => void;
let dbCount = 0;
const opened: Db[] = [];

beforeEach(() => {
  name = `update-after-refused-put-${++dbCount}`;
  budget = new BudgetFs(new MemoryFs(), 1024 * KiB);
  host = new EngineHost(() => budget);
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

/**
 * A put the browser refuses and an update of the same key, issued in one
 * turn. The origin has room for a row of a few bytes and none for the put's
 * kibibyte: an update that ran before the put would commit, and the put
 * would then replace what it wrote. Resolves with what the body read.
 */
async function putThenUpdate(): Promise<string | undefined> {
  const db = await openHarnessDb({ name, fs: budget, ingest: createLocalIngestClient(host), maxWalBytes: 1 << 30, reserveBytes: RESERVE });
  opened.push(db);
  await db.put(utf("first"), utf("row"));
  await ingest(db);
  expect(budget.sizeOf(RESERVE_PATH)).toBe(RESERVE);
  // In the memtable, so the update's transaction starts while the put's is in flight.
  await db.put(utf("count"), utf("0"));
  budget.limit = budget.used + 512;

  const put = db.batch((tx) => {
    tx.put(utf("count"), utf("1"));
    tx.put(utf("pad"), new Uint8Array(KiB));
  });
  const read = db.update([utf("count")], ([count], tx) => {
    tx.put(utf("count"), utf(`${text(count)}+1`));
    return text(count);
  });
  await put;
  await read;
  expect(text(await db.get(utf("count")))).toBe("1+1");
  return read;
}

describe("an update issued after a put of its handle that the browser refuses once", () => {
  it("reads that put and lands after it", async () => {
    const makeRoom = vi.spyOn(host, "makeRoom");
    expect(await putThenUpdate()).toBe("1");
    expect(makeRoom).toHaveBeenCalledTimes(1);
  });

  it("reads that put when the host made room before the update's transaction had read", async () => {
    const makeRoom = vi.spyOn(host, "makeRoom").mockImplementation(async () => void (budget.limit += RESERVE));
    expect(await putThenUpdate()).toBe("1");
    expect(makeRoom).toHaveBeenCalledTimes(1);
  });
});

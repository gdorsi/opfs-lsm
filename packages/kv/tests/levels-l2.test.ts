import { afterEach, expect, it } from "vitest";
import { compareBytes } from "../src/bytes.js";
import type { Db } from "../src/index.js";
import { createLocalIngestClient, EngineHost, ingest, MemoryFs, openHarnessDb } from "../src/testing.js";
import { applyOps, Oracle, show, type OracleOp, type OracleRange } from "./sim/oracle.js";
import { compactHost } from "./compact-host.js";

/**
 * Past L1's 40 MiB target compaction moves runs into L2: a step picks one
 * L1 run and merges it with the L2 runs it overlaps, and at the bottom it
 * drops tombstones and covered versions. No other test writes enough to get
 * there through the public API, so this one does, with overwrites, deletes
 * and range deletes that L2 rows must not come back from, and checks every
 * read against the oracle.
 */
const utf = (s: string) => new TextEncoder().encode(s);
let db: Db | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

it("reads agree with the oracle once compaction reaches L2", async () => {
  let state = 11;
  const rnd = (k: number) => (state = (Math.imul(state, 1103515245) + 12345) >>> 0) % k;
  const fs = new MemoryFs();
  const host = new EngineHost(() => fs);
  const name = `levels-l2-${process.pid}`;
  db = await openHarnessDb({ name, fs, ingest: createLocalIngestClient(host), maxWalBytes: 1 << 30, rowPostMs: 0 });
  const oracle = new Oracle();
  const KEYS = 9000;
  const keyOf = (i: number) => utf(`k/${String(i).padStart(5, "0")}`);
  let v = 0;
  const value = () => {
    const out = new Uint8Array(8 * 1024 + rnd(16 * 1024)).fill(0x61 + rnd(3));
    out.set(utf(`v${++v}.`));
    return out;
  };
  const check = async (label: string) => {
    for (let i = 0; i < 40; i++) {
      const k = keyOf(rnd(KEYS));
      expect(await db!.get(k), `${label}: get ${show(k)}`).toEqual(oracle.valueAt(k));
    }
    for (let i = 0; i < 6; i++) {
      const a = keyOf(rnd(KEYS));
      const b = keyOf(rnd(KEYS));
      const [start, endExclusive] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
      const range: OracleRange = { start, endExclusive, reverse: rnd(2) === 0, ...(rnd(2) ? { limit: rnd(50) } : {}) };
      const want = oracle.rangeAt(range).map((e) => `${show(e.key)}=${e.value.length}:${show(e.value.subarray(0, 12))}`);
      const got: string[] = [];
      for await (const e of db!.range(range)) got.push(`${show(e.key)}=${e.value.length}:${show(e.value.subarray(0, 12))}`);
      expect(got, `${label}: range ${show(start)}..${show(endExclusive)} ${JSON.stringify({ ...range, start: 0, endExclusive: 0 })}`).toEqual(want);
    }
    expect(await db!.count(), `${label}: count`).toBe(oracle.stateAt().length);
  };
  for (let round = 0; round < 80; round++) {
    const ops: OracleOp[] = [];
    for (let i = 0; i < 200; i++) {
      const r = rnd(20);
      const ki = rnd(KEYS);
      const k = keyOf(ki);
      if (r < 16) ops.push({ type: "put", key: k, value: value() });
      else if (r < 19) ops.push({ type: "del", key: k });
      else ops.push({ type: "deleteRange", start: k, endExclusive: keyOf(ki + 1 + rnd(40)) });
    }
    for (let i = 0; i < ops.length; i += 50) {
      const part = ops.slice(i, i + 50);
      await db.batch((tx) => applyOps(tx, part));
      oracle.append(part);
    }
    await ingest(db);
    await check(`round ${round}`);
  }
  await compactHost(host, name);
  await check("settled");
  expect((await fs.list("l2")).length, "compaction reached L2").toBeGreaterThan(0);
}, 600_000);

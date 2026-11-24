import { afterEach, expect, it } from "vitest";
import { compareBytes } from "../src/bytes.js";
import type { Db } from "../src/index.js";
import { createLocalIngestClient, EngineHost, ingest, MemoryFs, openHarnessDb } from "../src/testing.js";
import { applyOps, Oracle, show, type OracleOp, type OracleRange } from "./sim/oracle.js";
import { compactHost } from "./compact-host.js";

/**
 * A randomized differential test of reads against the sim oracle, aimed
 * where the sim's fixed 16-key set does not reach: hundreds of keys with
 * shared prefixes, values large enough to fill several blocks, range bounds
 * that land between and on keys in the middle of blocks, and a host with
 * small flush runs and few merge sources, so L0 runs and L1 runs coexist.
 * A wider sweep: KV_READ_SEEDS=400 KV_READ_STEPS=200, KV_READ_INVERT=1
 * (start above endExclusive), KV_READ_CACHE=1 (1 MiB cache, 40 KB values).
 */
const utf = (s: string) => new TextEncoder().encode(s);
let db: Db | undefined;
let n = 0;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

function keysOf(rnd: (n: number) => number): Uint8Array[] {
  const out: Uint8Array[] = [new Uint8Array(0), new Uint8Array([0]), new Uint8Array([0xff]), new Uint8Array([0xff, 0xff])];
  for (let i = 0; i < 300; i++) {
    const depth = rnd(4);
    let s = ["a", "b", "ab", "k/"][rnd(4)]!;
    for (let d = 0; d < depth; d++) s += ["/", "x", "\u0000", "0", "1", "zz"][rnd(6)]!;
    s += String(rnd(40)).padStart(rnd(2) ? 2 : 3, "0");
    out.push(utf(s));
  }
  return out;
}

async function run(seed: number): Promise<void> {
  let state = seed;
  const rnd = (k: number) => (state = (Math.imul(state, 1103515245) + 12345) >>> 0) % k;
  const keys = keysOf(rnd);
  const fs = new MemoryFs();
  const host = new EngineHost(() => fs, { flushRunBytes: 2048, l0StopRuns: Number.POSITIVE_INFINITY, maxSources: 3 });
  const name = `read-differential-${process.pid}-${++n}`;
  db = await openHarnessDb({ name, fs, ingest: createLocalIngestClient(host), maxWalBytes: 1 << 30, rowPostMs: 0, ...(process.env.KV_READ_CACHE ? { cacheBytes: 1 << 20 } : {}) });
  const oracle = new Oracle();
  let v = 0;
  const value = () => {
    const size = [0, 3, 40, 300, 1500, process.env.KV_READ_CACHE ? 40000 : 5000][rnd(6)]!;
    const out = new Uint8Array(size).fill("abc".charCodeAt(rnd(3)));
    out.set(utf(`v${++v}.`).subarray(0, size));
    return out;
  };
  const key = () => keys[rnd(keys.length)]!;
  const bound = () => {
    const k = key();
    // A key, or one just past it, or one shorter.
    switch (rnd(3)) {
      case 0:
        return k;
      case 1:
        return Uint8Array.of(...k, 0);
      default:
        return k.subarray(0, Math.max(0, k.length - 1));
    }
  };
  const log: string[] = [];
  for (let step = 0; step < Number(process.env.KV_READ_STEPS ?? 60); step++) {
    const what = rnd(10);
    if (what < 5) {
      const ops: OracleOp[] = [];
      const count = rnd(3) === 0 ? 40 + rnd(80) : 1 + rnd(4);
      for (let i = 0; i < count; i++) {
        const r = rnd(20);
        if (r < 12) ops.push({ type: "put", key: key(), value: value() });
        else if (r < 18) ops.push({ type: "del", key: key() });
        else {
          const a = bound();
          const b = bound();
          const [start, end] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
          const through = rnd(3) === 0 ? Math.max(0, oracle.head - rnd(5)) : undefined;
          ops.push({
            type: "deleteRange",
            start,
            ...(compareBytes(start, end) < 0 && rnd(4) ? { endExclusive: end } : {}),
            ...(through === undefined ? {} : { through }),
          });
        }
      }
      await db.batch((tx) => applyOps(tx, ops));
      oracle.append(ops);
      log.push(`batch ${ops.length}`);
    } else if (what < 7) {
      await ingest(db);
      log.push("ingest");
    } else if (what < 8) {
      await host.ingest(name);
      log.push("flush");
    } else if (what < 9) {
      await compactHost(host, name);
      log.push("compact");
    }
    // Reads after every step.
    const probe = key();
    expect(await db.get(probe), `${log.join(", ")}: get ${show(probe)}`).toEqual(oracle.valueAt(probe));
    const many = [key(), key(), key()];
    expect(await db.getMany(many), `${log.join(", ")}: getMany`).toEqual(many.map((k) => oracle.valueAt(k)));
    for (let r = 0; r < 3; r++) {
      const a = bound();
      const b = bound();
      const [start, end] = compareBytes(a, b) <= 0 || process.env.KV_READ_INVERT ? [a, b] : [b, a];
      const range: OracleRange = {
        ...(rnd(4) ? { start } : {}),
        ...(rnd(4) && (process.env.KV_READ_INVERT || compareBytes(start, end) < 0) ? { endExclusive: end } : {}),
        ...(rnd(2) ? { reverse: true } : {}),
        ...(rnd(2) ? { limit: rnd(12) } : {}),
        ...(rnd(3) === 0 ? { offset: rnd(5) } : {}),
        ...(rnd(4) === 0 ? { valueContains: [utf(["a", "b", "v1", "."][rnd(4)]!)] } : {}),
      };
      const label = `${log.join(", ")}: range ${JSON.stringify({ ...range, start: range.start && show(range.start), endExclusive: range.endExclusive && show(range.endExclusive), valueContains: undefined })}`;
      const want = oracle.rangeAt(range).map((e) => `${show(e.key)}=${show(e.value)}`);
      const got: string[] = [];
      for await (const e of db.range(range)) got.push(`${show(e.key)}=${show(e.value)}`);
      expect(got, `${label}`).toEqual(want);
      const counted = await db.count(range);
      expect(counted, `${label} count`).toBe(want.length);
    }
  }
}

for (const seed of Array.from({ length: Number(process.env.KV_READ_SEEDS ?? 8) }, (_, i) => i + 1)) {
  it(`reads agree with the oracle over many keys, several blocks and L0 over L1 (seed ${seed})`, async () => {
    await expect(run(seed)).resolves.toBeUndefined();
  }, 120_000);
}

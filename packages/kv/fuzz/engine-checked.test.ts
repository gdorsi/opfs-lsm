import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { EngineExports } from "../src/store/engine.js";
import { checkedFile, openChecked, openShipped, takeCheckedReports, type CheckedEngine } from "../checked/engine-under-test.ts";
import {
  concat,
  DONE,
  driveEncode,
  driveMerge,
  driveScan,
  encodeCase,
  encoded,
  mergeCase,
  pack,
  randomEntries,
  scanCase,
  u32s,
  xorshift,
  type Transcript,
} from "./engine-drive.js";

/**
 * The engine's memory safety: on its checked twin (checked/), the drive
 * cases never read or write outside a live block, never read a byte nobody
 * wrote, never free a block twice, leak nothing, never ask for a block sized
 * by a corrupt length field, and give the shipped build's transcript. The
 * shipped build never traps and stays inside bounded memory. Without
 * `KV_FUZZ_SEED` each run draws a seed, which a failure prints.
 *
 *   KV_ENGINE_CASES=3000 KV_FUZZ_SEED=7 pnpm exec vitest run fuzz/engine-checked.test.ts
 */
const env = process.env;
const CASES = Number(env.KV_ENGINE_CASES ?? 100);
const SEED = Number(env.KV_FUZZ_SEED ?? Math.floor(Math.random() * 2 ** 31));
const TIMEOUT = 60_000 + CASES * 500;
/** Memory the engine may reach, and the largest block it may ask for, on any case here. The largest input is under 1 MiB. */
const LIMIT = 64 << 20;

/** Between cases: a worker that never yields misses vitest's heartbeat, which fails a long sweep that passed. */
const breathe = () => new Promise((resolve) => setImmediate(resolve));

let twin: CheckedEngine;
let shipped: EngineExports;
beforeAll(() => {
  twin = openChecked();
  shipped = openShipped();
});

/**
 * How the twin broke a rule on `c`: a memory error, a transcript other than
 * the shipped build's, a trap, or a block or memory past the limit. Only a
 * malformed marks block, which the host encodes, may trap.
 */
function differences<C>(what: string, c: C, drive: (ex: EngineExports, c: C) => Transcript, mayTrap = false): string[] {
  let found: string[];
  let trapped = true;
  try {
    const want = drive(shipped, c);
    const got = drive(twin.exports, c);
    trapped = [...want, ...got].some((line) => line.startsWith("TRAP"));
    found = disagreements(what, want, got, mayTrap);
  } catch (err) {
    found = [`${what}: ${String(err)}`];
  }
  // A trapped or failed call keeps what it allocated, so the next case starts on fresh instances, as the host restarts its engine.
  if (trapped) {
    twin = openChecked();
    shipped = openShipped();
  }
  return found;
}

function disagreements(what: string, want: Transcript, got: Transcript, mayTrap: boolean): string[] {
  const trap = want.find((line) => line.startsWith("TRAP"));
  if (trap && !mayTrap) return [`${what}: ${trap}`];
  const at = got.findIndex((line, i) => line !== want[i]);
  if (at >= 0 || got.length !== want.length) return [`${what}: stop ${at}: twin gave ${got[at]?.slice(0, 200)}, shipped gave ${want[at]?.slice(0, 200)}`];
  if (shipped.memory.buffer.byteLength > LIMIT) return [`${what}: memory reached ${shipped.memory.buffer.byteLength} bytes`];
  return twin.largestAllocation() > LIMIT ? [`${what}: asked for a block of ${twin.largestAllocation()} bytes`] : [];
}

describe("the engine on its checked twin", () => {
  it(
    "encodes entry lists, malformed ones included",
    async () => {
      const r = xorshift(SEED);
      const found: string[] = [];
      for (let c = 0; c < 3 * CASES; c++) {
        found.push(...differences(`encode case ${c}`, encodeCase(r), driveEncode));
        await breathe();
      }
      expect({ seed: SEED, found, reports: takeCheckedReports() }).toEqual({ seed: SEED, found: [], reports: [] });
    },
    TIMEOUT,
  );

  it(
    "scans valid and corrupt blocks with valid and corrupt pattern lists",
    async () => {
      const r = xorshift(SEED + 1);
      const found: string[] = [];
      for (let c = 0; c < 3 * CASES; c++) {
        found.push(...differences(`scan case ${c}`, scanCase(r, shipped), driveScan));
        await breathe();
      }
      expect({ seed: SEED, found, reports: takeCheckedReports() }).toEqual({ seed: SEED, found: [], reports: [] });
    },
    TIMEOUT,
  );

  it(
    "merges valid and corrupt runs, whatever the host does",
    async () => {
      const r = xorshift(SEED + 2);
      const found: string[] = [];
      for (let c = 0; c < Math.ceil(CASES / 3); c++) {
        const mc = mergeCase(r, shipped);
        found.push(...differences(`merge case ${c} (host ${mc.host})`, mc, driveMerge, mc.badMarks));
        await breathe();
      }
      expect({ seed: SEED, found, reports: takeCheckedReports() }).toEqual({ seed: SEED, found: [], reports: [] });
    },
    TIMEOUT,
  );

  it("refuses what it cannot allocate with the shipped build's status", () => {
    const huge = 0xffffffff;
    const run = encoded(shipped, randomEntries(xorshift(SEED), 30, 1));
    const list = concat([u32s([2, 1, run.byteLength, 1, run.byteLength]), u32s([0])]);
    const open = (ex: EngineExports) => {
      const ptr = ex.input_ptr(list.byteLength) >>> 0;
      new Uint8Array(ex.memory.buffer, ptr, list.byteLength).set(list);
      return [ex.merge_open(ptr, list.byteLength, 0, 1 << 20, huge, 4096, 1 << 20), ex.merge_close(), ex.input_ptr(huge)];
    };
    const fresh = openChecked();
    expect(open(fresh.exports)).toEqual([-10, 0, 0]);
    expect(open(shipped)).toEqual([-10, 0, 0]);
    expect(takeCheckedReports()).toEqual([]);
  });

  it("returns -10, never a trap, when memory cannot hold a session", () => {
    const capped = new WebAssembly.Module(readFileSync(checkedFile("capped.wasm")));
    const run = encoded(shipped, randomEntries(xorshift(1), 50, 1));
    const statuses = new Set<number>();
    for (const chunk of [256, 10_000, 65_536]) {
      for (let n = 1; n <= 400; n++) {
        const ex = new WebAssembly.Instance(capped, {}).exports as unknown as EngineExports;
        const list = concat([u32s([n]), ...Array.from({ length: n }, () => u32s([1, run.byteLength])), u32s([0])]);
        const ptr = ex.input_ptr(list.byteLength) >>> 0;
        new Uint8Array(ex.memory.buffer, ptr, list.byteLength).set(list);
        statuses.add(ex.merge_open(ptr, list.byteLength, 0, 1 << 20, chunk, 4096, 1 << 20));
      }
    }
    expect([...statuses].sort()).toEqual([-10, 0]);
  });
});

describe("the shipped engine over a long session", () => {
  it("returns to the same memory after each round of flushes and merges", () => {
    const r = xorshift(SEED + 3);
    const ex = openShipped();
    const flush = { input: pack(randomEntries(r, 3000, 1)) };
    const sources = Array.from({ length: 6 }, (_, s) => [encoded(ex, randomEntries(r, 800, 10_000 * (s + 1)).sort((a, b) => Buffer.compare(a.key, b.key)))]);
    const merge = { sources, marks: u32s([0]), badMarks: false, drop: 0, target: 1 << 16, chunk: 4096, tail: 8192, yieldBytes: 1 << 20, host: 7 };
    const memory: number[] = [];
    for (let round = 0; round < 12; round++) {
      expect(driveEncode(ex, flush)[0]!.startsWith("0:")).toBe(true);
      expect(driveMerge(ex, merge).some((line) => line.startsWith(`${DONE}:`))).toBe(true);
      expect(driveEncode(ex, flush)[0]!.startsWith("0:")).toBe(true);
      memory.push(ex.memory.buffer.byteLength);
    }
    expect(memory.slice(3)).toEqual(memory.slice(3).map(() => memory[3]));
  });
});

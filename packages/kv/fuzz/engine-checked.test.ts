import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { EngineExports } from "../src/store/engine.js";
import { checkedFile, openChecked, openShipped, takeCheckedReports, type CheckedEngine } from "../checked/engine-under-test.ts";
import { blocksOf, fixSstCrc, footerOf } from "./targets.js";
import {
  blockFields,
  concat,
  DONE,
  driveEncode,
  driveMerge,
  driveScan,
  encodeCase,
  encoded,
  entryFields,
  HUGE,
  indexFields,
  inflated,
  mergeCase,
  NEED,
  pack,
  patternFields,
  randomEntries,
  scanCase,
  u32s,
  xorshift,
  type MergeCase,
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

function withCrc(run: Uint8Array): Uint8Array {
  fixSstCrc(run);
  return run;
}

const FOOTER = 40;

/** `run` with its block index replaced by `index`, of `rows` rows. */
function withIndex(run: Uint8Array, index: Uint8Array, rows: number): Uint8Array {
  const footer = run.slice(run.byteLength - FOOTER);
  const view = new DataView(footer.buffer);
  view.setUint32(4, rows, true);
  view.setUint32(24, index.byteLength, true);
  return withCrc(concat([run.subarray(0, view.getUint32(20, true)), index, footer]));
}

/** `run` with a second block so long that its end wraps to 0, a third block over all the data, and empty blocks after. */
function wrapsDataOffset(run: Uint8Array): Uint8Array {
  const out = run.slice();
  const view = new DataView(out.buffer);
  const { dataLen } = footerOf(run)!;
  const lengths = indexFields(run).filter((_, i) => i % 3 === 2);
  const rewrite = (row: number, offset: number, length: number) => {
    view.setUint32(lengths[row]!.at - 4, offset, true);
    view.setUint32(lengths[row]!.at, length, true);
  };
  rewrite(1, view.getUint32(lengths[1]!.at - 4, true), 2 ** 32 - view.getUint32(lengths[1]!.at - 4, true));
  rewrite(2, 0, dataLen);
  for (let row = 3; row < lengths.length; row++) rewrite(row, dataLen, 0);
  return withCrc(out);
}

const merge = (run: Uint8Array): MergeCase => ({ sources: [[run]], marks: u32s([0]), badMarks: false, drop: 0, target: 1 << 20, chunk: 4096, tail: 4096, yieldBytes: 1 << 20, host: 1 });
const status = (code: number) => (t: Transcript) => t.includes(`${code}:`);
/** A session that refuses a run's tail with `code` asks for the tail and no block. */
const refusedAtTail = (code: number) => (t: Transcript) => {
  const at = t.indexOf(`${code}:`);
  return at >= 0 && t.slice(0, at).filter((line) => line.startsWith(`${NEED}:`)).length === 1;
};

/** Checks that the twin refuses a case as `ok` says and as the shipped build does, and adds what it finds to `found`. */
function refuser(found: string[]) {
  return <C>(what: string, c: C, drive: (ex: EngineExports, c: C) => Transcript, ok: (t: Transcript) => boolean) => {
    const broke = differences(what, c, drive);
    if (!broke.length && !ok(drive(twin.exports, c))) broke.push(`${what}: not refused`);
    found.push(...broke);
  };
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

  it("refuses a length near 2^32 in any length field", () => {
    const es = randomEntries(xorshift(1), 100, 1).sort((a, b) => Buffer.compare(a.key, b.key));
    const input = pack(es);
    const run = encoded(shipped, es);
    const block = blocksOf(run)[1]!;
    const pats = concat([u32s([3]), Uint8Array.of(1, 2, 3), u32s([0]), u32s([1]), Uint8Array.of(9)]);
    const found: string[] = [];
    const refused = refuser(found);
    for (const value of HUGE) {
      for (const f of entryFields(input)) refused(`entry length at ${f.at} = ${value}`, { input: inflated(input, f, value) }, driveEncode, status(-5));
      for (const f of blockFields(block)) refused(`block length at ${f.at} = ${value}`, { block: inflated(block, f, value), patterns: pats }, driveScan, status(-5));
      for (const f of patternFields(pats)) refused(`pattern length at ${f.at} = ${value}`, { block, patterns: inflated(pats, f, value) }, driveScan, status(-11));
      for (const f of indexFields(run)) refused(`index length at ${f.at} = ${value}`, merge(withCrc(inflated(run, f, value))), driveMerge, refusedAtTail(-5));
    }
    // A check written `o + len > end` takes each of these: a length of 0xffffffff steps back to offset 3, where `ff 00 00 00` names the 255 bytes left.
    const stepsBack = concat([u32s([0xffffffff]), new Uint8Array(3), new Uint8Array(255).fill(7)]);
    const { dataLen } = footerOf(run)!;
    refused("a pattern list whose first length steps back", { block, patterns: stepsBack }, driveScan, status(-11));
    refused("an index whose first key length steps back", merge(withIndex(run, concat([stepsBack, u32s([0, dataLen])]), 1)), driveMerge, refusedAtTail(-5));
    refused("an index whose block lengths wrap the data offset", merge(wrapsDataOffset(run)), driveMerge, refusedAtTail(-5));
    expect({ found, reports: takeCheckedReports() }).toEqual({ found: [], reports: [] });
  });

  it("refuses a malformed run or block with the status Rust gave", () => {
    const es = randomEntries(xorshift(1), 100, 1).sort((a, b) => Buffer.compare(a.key, b.key));
    const run = encoded(shipped, es);
    const { blockCount, indexStart } = footerOf(run)!;
    const index = run.subarray(indexStart, run.byteLength - FOOTER);
    const lastRow = indexFields(run).at(-3)!.at;
    const block = blocksOf(run)[1]!;
    const prefix = blockFields(block)[0]!;
    const found: string[] = [];
    const refused = refuser(found);
    refused("a run shorter than a footer", merge(new Uint8Array(FOOTER - 1)), driveMerge, (t) => t[0] === "-1:");
    refused("an index with a byte after its rows", merge(withIndex(run, concat([index, Uint8Array.of(0)]), blockCount)), driveMerge, refusedAtTail(-7));
    refused("an index whose blocks stop short of the data", merge(withIndex(run, index.subarray(0, lastRow - indexStart), blockCount - 1)), driveMerge, refusedAtTail(-5));
    refused("a varint of six bytes", { block: concat([block.subarray(0, prefix.at), Uint8Array.of(0x80, 0x80, 0x80, 0x80, 0x80, 0), block.subarray(prefix.at + prefix.width)]), patterns: new Uint8Array(0) }, driveScan, (t) => t[0] === "-9:");
    expect({ found, reports: takeCheckedReports() }).toEqual({ found: [], reports: [] });
  });

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

  it("fails a merge that memory cannot hold, and never changes its output", () => {
    const capped = new WebAssembly.Module(readFileSync(checkedFile("capped.wasm")));
    const outcomes = new Set<string>();
    const found: string[] = [];
    for (let size = 50_000; size <= 700_000; size += 10_000) {
      const c = merge(encoded(shipped, [{ del: false, key: Uint8Array.of(107), value: new Uint8Array(size).fill(9), seq: 1n }]));
      const got = driveMerge(new WebAssembly.Instance(capped, {}).exports as unknown as EngineExports, c);
      const outcome = got.some((line) => line.startsWith("TRAP")) ? "trap" : got.includes("-10:") ? "-10" : "done";
      outcomes.add(outcome);
      if (outcome === "done" && got.join("\n") !== driveMerge(shipped, c).join("\n")) found.push(`a value of ${size} bytes: other output under the cap`);
    }
    expect({ found, outcomes: [...outcomes].sort() }).toEqual({ found: [], outcomes: ["-10", "done", "trap"] });
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

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { EngineExports } from "../src/store/engine.js";
import { blocksOf, fixSstCrc } from "./targets.js";

/**
 * The engine against the Rust engine it was ported from, frozen as
 * tests/oracle/engine-rust.wasm: the same bytes in give the same status and
 * the same bytes out through every export of packages/kv/engine/abi.md, on
 * valid and corrupt input. The Rust engine's own tests proved its writer,
 * its merge session and its handling of mutated input, so matching it
 * carries those proofs over. The engine must also never trap and stay
 * inside bounded memory.
 *
 * Without `KV_FUZZ_SEED` each run draws a seed, which a failure prints.
 *
 *   KV_REFERENCE_CASES=3000 KV_FUZZ_SEED=7 pnpm exec vitest run fuzz/rust-reference.test.ts
 */
const env = process.env;
const RUNS = Number(env.KV_REFERENCE_CASES ?? 300);
const SEED = Number(env.KV_FUZZ_SEED ?? Math.floor(Math.random() * 2 ** 31));
const TIMEOUT = 60_000 + RUNS * 100;
/** Memory the engine may reach on any case here. The largest input is under 1 MiB. */
const MEMORY_LIMIT = 64 << 20;

const NEED = 1;
const DONE = 5;
const TAG_PUT = 1;
const TAG_DEL = 2;

async function instantiate(path: string): Promise<EngineExports> {
  const bytes = await readFile(fileURLToPath(new URL(path, import.meta.url)));
  return (await WebAssembly.instantiate(bytes, {})).instance.exports as unknown as EngineExports;
}

let rust: EngineExports;
let engine: EngineExports;
beforeAll(async () => {
  rust = await instantiate("../tests/oracle/engine-rust.wasm");
  engine = await instantiate("../wasm/engine.wasm");
});

/** xorshift32, so a failing case replays from its seed. */
function rng(seed: number) {
  let state = seed >>> 0 || 1;
  const next = () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
  const int = (n: number) => (n > 0 ? next() % n : 0);
  const bytes = (n: number, alphabet = 256) => Uint8Array.from({ length: n }, () => int(alphabet));
  const pick = <T>(xs: readonly T[]) => xs[int(xs.length)]!;
  return { int, bytes, pick };
}
type Rng = ReturnType<typeof rng>;

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function result(ex: EngineExports): string {
  return hex(new Uint8Array(ex.memory.buffer, ex.result_ptr() >>> 0, ex.result_len()));
}

/** Write `input` to the input region and run `op` on it: the status and the result bytes. */
function call(ex: EngineExports, input: Uint8Array, op: (ptr: number) => number): string {
  const ptr = ex.input_ptr(input.byteLength) >>> 0;
  new Uint8Array(ex.memory.buffer, ptr, input.byteLength).set(input);
  const status = op(ptr);
  return `${status}:${result(ex)}`;
}

/** What `run` did on each engine. A trap ends a run, so it is recorded instead. */
function both(run: (ex: EngineExports) => string[]): [string[], string[]] {
  const outcome = (ex: EngineExports) => {
    try {
      return run(ex);
    } catch (err) {
      if (err instanceof WebAssembly.RuntimeError) return [`TRAP ${err.message}`];
      throw err;
    }
  };
  return [outcome(rust), outcome(engine)];
}

/**
 * How the engine broke a rule on `run`: it differed from Rust, trapped, or
 * passed the memory limit. Empty when it broke none. Only a malformed marks
 * block, which the host encodes, may trap, where Rust traps.
 */
function differences(what: string, run: (ex: EngineExports) => string[], mayTrap = false): string[] {
  const [want, got] = both(run);
  const trap = got.find((line) => line.startsWith("TRAP"));
  if (trap && !mayTrap) return [`${what}: ${trap}`];
  const at = got.findIndex((line, i) => line !== want[i]);
  if (at >= 0 || got.length !== want.length) return [`${what}: stop ${at}: got ${got[at]?.slice(0, 200)}, Rust gave ${want[at]?.slice(0, 200)}`];
  const bytes = engine.memory.buffer.byteLength;
  return bytes > MEMORY_LIMIT ? [`${what}: memory reached ${bytes} bytes`] : [];
}

type Entry = { del: boolean; key: Uint8Array; value: Uint8Array; seq: bigint };

function key(r: Rng): Uint8Array {
  const shape = r.int(4);
  if (shape === 0) return r.bytes(r.int(4), 3);
  if (shape === 1) return new TextEncoder().encode(`k/${String(r.int(5000)).padStart(6, "0")}`);
  if (shape === 2) return r.bytes(1 + r.int(40), 4);
  return r.bytes(r.int(300));
}

function entries(r: Rng, n: number, seq0: number): Entry[] {
  return Array.from({ length: n }, (_, i) => ({
    del: r.int(5) === 0,
    key: key(r),
    value: r.bytes(r.int(40) === 0 ? 5000 + r.int(70_000) : r.int(200), r.int(2) ? 6 : 256),
    seq: r.int(50) === 0 ? 2n ** 40n + BigInt(r.int(1000)) : BigInt(seq0 + i),
  }));
}

/** Entry records (packages/kv/engine/abi.md, "Wire formats"). */
function pack(es: readonly Entry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const e of es) {
    const head = new DataView(new ArrayBuffer(13));
    head.setUint8(0, e.del ? TAG_DEL : TAG_PUT);
    head.setBigUint64(1, e.seq, true);
    head.setUint32(9, e.key.byteLength, true);
    parts.push(new Uint8Array(head.buffer), e.key);
    if (!e.del) parts.push(u32s([e.value.byteLength]), e.value);
  }
  return concat(parts);
}

function u32s(values: readonly number[]): Uint8Array {
  const out = new DataView(new ArrayBuffer(4 * values.length));
  values.forEach((v, i) => out.setUint32(4 * i, v >>> 0, true));
  return new Uint8Array(out.buffer);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

/** A corrupt copy: a bit flip, a cut, overwritten bytes, appended bytes, or a u32 inflated. */
function corrupt(r: Rng, b: Uint8Array): Uint8Array {
  const out = b.slice();
  const kind = r.int(5);
  if (kind === 0 && out.length) out[r.int(out.length)]! ^= 1 << r.int(8);
  if (kind === 1) return out.subarray(0, r.int(out.length + 1));
  if (kind === 2 && out.length) for (let i = 0; i < 1 + r.int(8); i++) out[r.int(out.length)] = r.int(256);
  if (kind === 3) return concat([out, r.bytes(1 + r.int(8))]);
  if (kind === 4 && out.length >= 4) new DataView(out.buffer).setUint32(r.int(out.length - 3), r.pick([0xffffffff, 0x7fffffff, 0x10000, 0x41]), true);
  return out;
}

/** The run of `es` as the Rust engine encodes it. */
function encoded(es: readonly Entry[]): Uint8Array {
  const input = pack(es);
  const out = call(rust, input, (ptr) => rust.encode_sst(ptr, input.byteLength));
  const record = Buffer.from(out.slice(out.indexOf(":") + 1), "hex");
  const size = record.readUInt32LE(4);
  return new Uint8Array(record.subarray(16, 16 + size));
}

const encode = (input: Uint8Array) => (ex: EngineExports) => [call(ex, input, (ptr) => ex.encode_sst(ptr, input.byteLength))];

function patterns(r: Rng): Uint8Array {
  return concat(Array.from({ length: r.int(3) }, () => r.bytes(r.int(3), r.int(2) ? 6 : 256)).flatMap((p) => [u32s([p.byteLength]), p]));
}

const scan = (block: Uint8Array, pats: Uint8Array) => (ex: EngineExports) => [
  call(ex, concat([block, pats]), (ptr) => ex.scan_block_contains(ptr, block.byteLength, ptr + block.byteLength, pats.byteLength)),
];

type MergeCase = {
  sources: Uint8Array[][];
  marks: Uint8Array;
  /** The marks block was corrupted, so a session may trap. */
  badMarks: boolean;
  drop: number;
  target: number;
  chunk: number;
  tail: number;
  yieldBytes: number;
  host: number;
};

/** A marks block: u32 count, then per mark start, optional end, u64 through and u64 at. */
function marksBlock(r: Rng): Uint8Array {
  const marks = Array.from({ length: r.int(3) }, () => {
    const start = key(r);
    const end = r.int(2) ? concat([start, Uint8Array.of(0xff)]) : undefined;
    const seqs = new DataView(new ArrayBuffer(16));
    seqs.setBigUint64(0, BigInt(1 + r.int(800)), true);
    seqs.setBigUint64(8, BigInt(5000 + r.int(10)), true);
    return concat([u32s([start.byteLength]), start, Uint8Array.of(end ? 1 : 0), ...(end ? [u32s([end.byteLength]), end] : []), new Uint8Array(seqs.buffer)]);
  });
  return concat([u32s([marks.length]), ...marks]);
}

function mergeCase(r: Rng): MergeCase {
  let seq = 1;
  const sources = Array.from({ length: r.int(6) }, () => {
    const all = entries(r, r.int(400), seq).sort((a, b) => Buffer.compare(a.key, b.key));
    seq += 1000;
    const per = Math.ceil(all.length / (1 + r.int(3))) || 1;
    const runs: Uint8Array[] = [];
    for (let at = 0; at < Math.max(all.length, 1); at += per) {
      const slice = all.slice(at, at + per);
      if (r.int(30) === 0) slice.reverse();
      runs.push(encoded(slice));
    }
    if (runs.length && r.int(8) === 0) {
      const i = r.int(runs.length);
      runs[i] = corrupt(r, runs[i]!);
      // Past the CRC, the footer, index and blocks are what refuse it.
      if (r.int(2)) fixSstCrc(runs[i]!);
    }
    return runs;
  });
  const marks = marksBlock(r);
  const badMarks = marks.byteLength > 4 && r.int(10) === 0;
  return {
    sources,
    marks: badMarks ? concat([marks.subarray(0, 4), corrupt(r, marks.subarray(4))]) : marks,
    badMarks,
    drop: r.int(2),
    target: r.pick([0, 64, 1024, 16384, 1 << 22, Number.MAX_SAFE_INTEGER, 1e20, -5, Number.NaN]),
    chunk: r.pick([0, 16, 256, 4096, 65536]),
    tail: r.pick([0, 16, 256, 4096, 65536]),
    yieldBytes: r.pick([0, 1, 1000, 1 << 20]),
    host: 1 + r.int(2 ** 30),
  };
}

/**
 * Every stop of a session over `c`, driven the way a host may: demands fed
 * in any order, now and then a feed of the wrong length or a pump before the
 * last feed, and the calls a host must not make while a session is open or
 * after it is closed.
 */
const merge = (c: MergeCase) => (ex: EngineExports) => {
  const r = rng(c.host);
  const list = concat([u32s([c.sources.length]), ...c.sources.map((runs) => u32s([runs.length, ...runs.map((b) => b.byteLength)])), c.marks]);
  const open = (ptr: number) => ex.merge_open(ptr, list.byteLength, c.drop, c.target, c.chunk, c.tail, c.yieldBytes);
  const log = [call(ex, list, open)];
  if (!log[0]!.startsWith("0:")) return [...log, `pump ${ex.merge_pump()}`];
  log.push(call(ex, list, open));
  try {
    pump(ex, c, r, log);
  } catch (err) {
    // A trap leaves the session open in the instance.
    ex.merge_close();
    throw err;
  }
  log.push(`close ${ex.merge_close()} ${ex.merge_close()} pump ${ex.merge_pump()} feed ${ex.merge_feed(0, 0)}`);
  return log;
};

function pump(ex: EngineExports, c: MergeCase, r: Rng, log: string[]): void {
  for (let stops = 0; stops < 100_000; stops++) {
    const status = ex.merge_pump();
    log.push(`${status}:${result(ex)}`);
    if (status < 0 || status === DONE) {
      log.push(`again ${ex.merge_pump()}`);
      break;
    }
    if (status !== NEED) continue;
    const view = new DataView(ex.memory.buffer, ex.result_ptr() >>> 0, ex.result_len());
    const demands = Array.from({ length: view.byteLength / 16 }, (_, i) => [0, 4, 8, 12].map((o) => view.getUint32(16 * i + o, true)) as [number, number, number, number]);
    for (let i = demands.length - 1; i > 0; i--) {
      const j = r.int(i + 1);
      [demands[i], demands[j]] = [demands[j]!, demands[i]!];
    }
    demands.forEach(([source, run, offset, len], i) => {
      if (r.int(8) === 0) log.push(`wrong length ${ex.merge_feed(source, len + 1) !== 0}`);
      if (i === demands.length - 1 && r.int(6) === 0) log.push(`early ${ex.merge_pump()}`);
      const at = ex.merge_feed(source, len) >>> 0;
      log.push(`feed ${at !== 0}`);
      if (at) new Uint8Array(ex.memory.buffer, at, len).set(c.sources[source]![run]!.subarray(offset, offset + len));
    });
  }
}

describe("the engine against the frozen Rust engine", () => {
  it(
    "encodes entry lists, malformed ones included, to the same run records and statuses",
    () => {
      const r = rng(SEED);
      const found: string[] = [];
      for (let c = 0; c < RUNS; c++) {
        const es = entries(r, r.pick([0, 1, 2, 5, 30, 200, 2000]), 1 + r.int(100));
        const input = pack(es);
        found.push(...differences(`encode case ${c}`, encode(input)));
        found.push(...differences(`malformed encode case ${c}`, encode(corrupt(r, input))));
        if (input.byteLength) {
          const tagged = input.slice();
          tagged[0] = r.pick([0, 3, 255]);
          found.push(...differences(`bad tag case ${c}`, encode(tagged)));
        }
      }
      expect({ seed: SEED, found }).toEqual({ seed: SEED, found: [] });
    },
    TIMEOUT,
  );

  it(
    "scans the same hits out of valid and corrupt blocks",
    () => {
      const r = rng(SEED + 1);
      const found: string[] = [];
      for (let c = 0; c < RUNS; c++) {
        const run = encoded(entries(r, r.pick([1, 5, 30, 200]), 1));
        for (const block of blocksOf(run)) {
          const pats = patterns(r);
          found.push(...differences(`scan case ${c}`, scan(block, pats)));
          found.push(...differences(`corrupt block case ${c}`, scan(corrupt(r, block), pats)));
          found.push(...differences(`corrupt patterns case ${c}`, scan(block, corrupt(r, pats))));
        }
      }
      expect({ seed: SEED, found }).toEqual({ seed: SEED, found: [] });
    },
    TIMEOUT,
  );

  it(
    "merges valid and corrupt runs with the same stops, whatever the host does",
    () => {
      const r = rng(SEED + 2);
      const found: string[] = [];
      for (let c = 0; c < Math.ceil(RUNS / 3); c++) {
        const mc = mergeCase(r);
        found.push(...differences(`merge case ${c} (host ${mc.host})`, merge(mc), mc.badMarks));
      }
      expect({ seed: SEED, found }).toEqual({ seed: SEED, found: [] });
    },
    TIMEOUT,
  );

  it("refuses what it cannot allocate with the same status", () => {
    const huge = 0xffffffff;
    const run = encoded(entries(rng(SEED), 30, 1));
    const list = concat([u32s([2, 1, run.byteLength, 1, run.byteLength]), u32s([0])]);
    const open = (ex: EngineExports) => [call(ex, list, (ptr) => ex.merge_open(ptr, list.byteLength, 0, 1 << 20, huge, 4096, 1 << 20)), `close ${ex.merge_close()}`];
    expect(both(open)).toEqual([["-10:", "close 0"], ["-10:", "close 0"]]);
    expect(both((ex) => [`${ex.input_ptr(huge)}`])).toEqual([["0"], ["0"]]);
  });
});

describe("the engine over a long session", () => {
  it("returns to the same memory after each round of flushes and merges", () => {
    const r = rng(SEED + 3);
    const flush = pack(entries(r, 3000, 1));
    const sources = Array.from({ length: 6 }, (_, s) => [encoded(entries(r, 800, 10_000 * (s + 1)).sort((a, b) => Buffer.compare(a.key, b.key)))]);
    const c: MergeCase = { sources, marks: u32s([0]), badMarks: false, drop: 0, target: 1 << 16, chunk: 4096, tail: 8192, yieldBytes: 1 << 20, host: 7 };
    const memory: number[] = [];
    for (let round = 0; round < 12; round++) {
      expect(encode(flush)(engine)[0]!.startsWith("0:")).toBe(true);
      expect(merge(c)(engine).some((line) => line.startsWith(`${DONE}:`))).toBe(true);
      expect(encode(flush)(engine)[0]!.startsWith("0:")).toBe(true);
      memory.push(engine.memory.buffer.byteLength);
    }
    expect(memory.slice(3)).toEqual(memory.slice(3).map(() => memory[3]));
  });
});

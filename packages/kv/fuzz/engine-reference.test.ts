import fc from "fast-check";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { packPatterns } from "../src/store/block-scan.js";
import type { EngineExports } from "../src/store/engine.js";
import { encodeMarks, type Mark } from "../src/store/marks.js";
import type { SstEntry } from "../src/store/sst.js";
import { decodeSst, encodeSstRef } from "../tests/oracle/sst-ref.js";
import { applyMutations, entriesArb, mutationsArb } from "./mutate.js";
import { blocksOf, repairSst, type Repair } from "./targets.js";

/**
 * The engine against the Rust module it was ported from, frozen in
 * tests/oracle/engine-rust.wasm. The same calls, valid or not, must give the
 * same status and the same result bytes, and trap only where the reference
 * traps: the runs a flush encodes, block scans, and merge sessions stop by
 * stop, through a host that slips on the session protocol.
 *
 *   KV_FUZZ_RUNS=5000 pnpm exec vitest run fuzz/engine-reference.test.ts
 */
const env = process.env;
const RUNS = Number(env.KV_FUZZ_RUNS ?? 300);
const params: fc.Parameters<unknown> = {
  numRuns: RUNS,
  ...(env.KV_FUZZ_SEED ? { seed: Number(env.KV_FUZZ_SEED), ...(env.KV_FUZZ_PATH ? { path: env.KV_FUZZ_PATH } : {}) } : {}),
};
const TIMEOUT = 60_000 + RUNS * 200;
/** No call on these small inputs may take the module's memory past this. */
const MEMORY_LIMIT = 64 << 20;

const compile = async (rel: string) => new WebAssembly.Module(await readFile(fileURLToPath(new URL(rel, import.meta.url))));
const [engineModule, referenceModule] = await Promise.all([compile("../wasm/engine.wasm"), compile("../tests/oracle/engine-rust.wasm")]);

type Answer = { code: number | "trap"; bytes: Uint8Array };
const show = (a: Answer) => `${a.code}:${Buffer.from(a.bytes).toString("hex")}`;

/** One instance of a module. A trap replaces it, as `engine.ts` does. */
class Engine {
  ex!: EngineExports;
  constructor(private readonly module: WebAssembly.Module) {
    this.reset();
  }
  reset(): void {
    this.ex = new WebAssembly.Instance(this.module, {}).exports as unknown as EngineExports;
  }
  /** What `op` returns, and the result region after it. */
  call(op: (ex: EngineExports) => number): Answer {
    try {
      const code = op(this.ex);
      const at = this.ex.result_ptr() >>> 0;
      return { code, bytes: new Uint8Array(this.ex.memory.buffer, at, this.ex.result_len()).slice() };
    } catch (e) {
      if (!(e instanceof WebAssembly.RuntimeError)) throw e;
      this.reset();
      return { code: "trap", bytes: new Uint8Array() };
    }
  }
  /** `op` on `input`, written to the input region. */
  with(input: Uint8Array, op: (ex: EngineExports, ptr: number) => number): Answer {
    return this.call((ex) => {
      const ptr = ex.input_ptr(input.byteLength) >>> 0;
      new Uint8Array(ex.memory.buffer, ptr, input.byteLength).set(input);
      return op(ex, ptr);
    });
  }
  memoryBytes(): number {
    return this.ex.memory.buffer.byteLength;
  }
}

const engine = new Engine(engineModule);
const reference = new Engine(referenceModule);

/** Both modules through `run`: the same answers, in the same order. */
function same(run: (e: Engine) => string[]): void {
  expect(run(engine)).toEqual(run(reference));
  expect(engine.memoryBytes()).toBeLessThanOrEqual(MEMORY_LIMIT);
}

/** Entry records as the ABI packs them (engine-abi.md, "Wire formats"). */
function records(entries: readonly SstEntry[]): Uint8Array {
  const parts = entries.map((e) => {
    const value = e.kind === "put" ? e.value : undefined;
    const out = new Uint8Array(13 + e.key.byteLength + (value ? 4 + value.byteLength : 0));
    const view = new DataView(out.buffer);
    out[0] = value ? 1 : 2;
    view.setBigUint64(1, BigInt(e.seq ?? 0), true);
    view.setUint32(9, e.key.byteLength, true);
    out.set(e.key, 13);
    if (value) {
      view.setUint32(13 + e.key.byteLength, value.byteLength, true);
      out.set(value, 17 + e.key.byteLength);
    }
    return out;
  });
  return new Uint8Array(Buffer.concat(parts));
}

const encode = (e: Engine, input: Uint8Array) => e.with(input, (ex, ptr) => ex.encode_sst(ptr, input.byteLength));

/** Writes in any key order, a key sometimes written twice. */
const writesArb = fc
  .tuple(entriesArb, entriesArb)
  .chain(([a, b]) => fc.shuffledSubarray([...a, ...b], { minLength: a.length + b.length }));

const runArb = fc.record({ entries: entriesArb, blockTarget: fc.constantFrom(64, 512, 4096) });
const keyArb = fc.string({ unit: fc.constantFrom(..."ab/0129".split("")), maxLength: 6 }).map((s) => new TextEncoder().encode(`t/${s}`));
const patternArb = fc.oneof(fc.constant(new TextEncoder().encode(" hot")), fc.uint8Array({ maxLength: 3 }));

/** A source: one key-ordered stream of entries cut into runs, one of them sometimes mutated. */
const sourceArb = fc.record({
  run: runArb,
  cuts: fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { maxLength: 2 }),
  damage: fc.option(fc.record({ run: fc.nat(), mutations: mutationsArb, repair: fc.constantFrom<Repair>("none", "crc", "trailer") }), { freq: 4 }),
});

const sessionArb = fc.record({
  sources: fc.array(sourceArb, { minLength: 1, maxLength: 4 }),
  marks: fc.array(fc.record({ start: keyArb, end: fc.option(keyArb), through: fc.integer({ min: 1, max: 2 ** 40 }) }), { maxLength: 3 }),
  dropTombstones: fc.boolean(),
  targetBytes: fc.constantFrom(1, 64, 1024, 16384, Number.MAX_SAFE_INTEGER),
  /** The last cannot be reserved. */
  chunkBytes: fc.constantFrom(0, 16, 256, 4096, 65536, 0xffff_ffff),
  tailBytes: fc.constantFrom(0, 16, 256, 4096, 65536),
  yieldBytes: fc.constantFrom(0, 1, 1000, 1 << 20),
  /** What the host does at each `need`, in turn: 0-4 are slips, the rest feed every demand in order. */
  host: fc.array(fc.nat(9), { minLength: 1, maxLength: 16 }),
  flush: writesArb,
});

type Session = typeof sessionArb extends fc.Arbitrary<infer T> ? T : never;

function runsOf(source: Session["sources"][number]): Uint8Array[] {
  const { entries, blockTarget } = source.run;
  const cuts = [...new Set(source.cuts.map((c) => Math.floor(c * entries.length)))].sort((a, b) => a - b);
  const bounds = [0, ...cuts, entries.length];
  const runs = bounds.slice(1).map((end, i) => encodeSstRef(entries.slice(bounds[i], end), blockTarget));
  if (source.damage) {
    const i = source.damage.run % runs.length;
    runs[i] = applyMutations(runs[i]!, source.damage.mutations, runs[(i + 1) % runs.length]!);
    repairSst(runs[i]!, source.damage.repair);
  }
  return runs;
}

/** Every stop of a merge session over `s`, and what each slip of the host got back. */
function sessionTrace(e: Engine, s: Session, sources: Uint8Array[][]): string[] {
  const marks: Mark[] = s.marks.map((m) => ({ start: m.start, ...(m.end ? { endExclusive: m.end } : {}), through: m.through, at: m.through + 1 }));
  const list = [sources.length, ...sources.flatMap((runs) => [runs.length, ...runs.map((r) => r.byteLength)])];
  const head = new Uint8Array(new Uint32Array(list).buffer);
  const input = new Uint8Array(Buffer.concat([head, encodeMarks(marks)]));
  const open = () =>
    e.with(input, (ex, ptr) => ex.merge_open(ptr, input.byteLength, s.dropTombstones ? 1 : 0, s.targetBytes, s.chunkBytes, s.tailBytes, s.yieldBytes));
  const pump = () => e.call((ex) => ex.merge_pump());
  const refused = (source: number, len: number) => e.call((ex) => ((ex.merge_feed(source, len) >>> 0) === 0 ? 0 : 1)).code;
  const feed = (demands: number[][]) => {
    for (const [source, run, offset, len] of demands) {
      const bytes = sources[source!]![run!]!.subarray(offset!, offset! + len!);
      const at = e.ex.merge_feed(source!, len!) >>> 0;
      if (at === 0) return "refused";
      new Uint8Array(e.ex.memory.buffer, at, len!).set(bytes);
    }
    return "fed";
  };
  const out = [show(open())];
  for (let i = 0, slip = 0; i < 50_000; i++) {
    const stop = pump();
    out.push(show(stop));
    if (stop.code === 2 || stop.code === 3 || stop.code === 4) continue;
    if (stop.code !== 1) {
      out.push(show(pump()));
      break;
    }
    const words = new Uint32Array(stop.bytes.slice().buffer);
    const demands = Array.from({ length: words.length / 4 }, (_, d) => [...words.subarray(4 * d, 4 * d + 4)]);
    const [first] = demands;
    switch (s.host[slip++ % s.host.length]) {
      case 0:
        out.push(`early ${show(pump())}`);
        break;
      case 1:
        out.push(`long ${refused(first![0]!, first![3]! + 1)}`);
        break;
      case 2:
        out.push(`stranger ${refused(sources.length + 2, first![3]!)}`);
        break;
      case 3:
        out.push(`reopen ${show(open())}`);
        break;
      case 4:
        out.push(`flush ${show(encode(e, records(s.flush)))}`);
        break;
    }
    out.push(feed(s.host.length % 2 === 0 ? demands : demands.reverse()));
  }
  out.push(show(e.call((ex) => ex.merge_close())), show(pump()), show(e.call((ex) => ex.merge_close())));
  return out;
}

describe("the engine against the frozen Rust module", () => {
  const encodes = fc.property(writesArb, fc.option(mutationsArb, { freq: 2 }), (writes, ms) => {
    const packed = records(writes);
    const input = ms ? applyMutations(packed, ms, packed) : packed;
    same((e) => [show(encode(e, input))]);
  });

  const scans = fc.property(runArb, fc.option(mutationsArb, { freq: 2 }), fc.array(patternArb, { maxLength: 3 }), fc.nat(8), (r, ms, pats, cut) => {
    const run = encodeSstRef(r.entries, r.blockTarget);
    const packed = packPatterns(pats);
    // Sometimes a pattern list cut short.
    const patterns = cut === 0 ? packed.subarray(0, Math.max(0, packed.byteLength - 1)) : packed;
    same((e) =>
      blocksOf(run)
        .slice(0, 6)
        .map((block) => {
          const b = ms ? applyMutations(block, ms, run) : block;
          const input = new Uint8Array(Buffer.concat([b, patterns]));
          return show(e.with(input, (ex, ptr) => ex.scan_block_contains(ptr, b.byteLength, ptr + b.byteLength, patterns.byteLength)));
        }),
    );
  });

  const merges = fc.property(sessionArb, (s) => {
    const sources = s.sources.map(runsOf);
    same((e) => sessionTrace(e, s, sources));
  });

  it("encodes the same runs from the same writes, and refuses the same malformed records", () => {
    expect(fc.assert(encodes, params)).toBeUndefined();
  }, TIMEOUT);

  it("scans the same blocks to the same hits, intact or mutated", () => {
    expect(fc.assert(scans, params)).toBeUndefined();
  }, TIMEOUT);

  it("runs the same merge sessions, stop by stop, over valid and corrupt runs", () => {
    expect(fc.assert(merges, { ...params, numRuns: Math.ceil(RUNS / 3) })).toBeUndefined();
  }, TIMEOUT);

  it("encodes, scans and merges every run of the fuzz corpus the same", async () => {
    const dir = new URL("./corpus/sst-decode/", import.meta.url);
    // A plain Uint8Array: the reference decoder's `slice` would be a view of a Buffer.
    const runs = await Promise.all((await readdir(dir)).map(async (name) => new Uint8Array(await readFile(new URL(name, dir))).subarray(1)));
    expect(runs.length).toBeGreaterThan(0);
    const s = fc.sample(sessionArb, { seed: 1, numRuns: 1 })[0]!;
    for (const run of runs) {
      same((e) => [show(encode(e, records(decodeSst(run))))]);
      same((e) => blocksOf(run).map((b) => show(e.with(b, (ex, ptr) => ex.scan_block_contains(ptr, b.byteLength, ptr, 0)))));
      same((e) => sessionTrace(e, { ...s, host: [9], marks: [] }, [[run], [run]]));
    }
  });
});

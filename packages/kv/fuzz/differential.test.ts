import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compareBytes } from "../src/bytes.js";
import { CorruptDatabaseError } from "../src/errors.js";
import { packPatterns, unpackHits } from "../src/store/block-scan.js";
import { encodeSst as encodeSstWasm, type MergeSpec } from "../src/store/engine.js";
import { lz4DecompressJs } from "../src/store/lz4.js";
import { openMergeTs } from "../tests/oracle/merge-ts.js";
import { BlockEntries, blockBytes, decodeSst, encodeSst, type EncodedRun, type SstEntry } from "../src/store/sst.js";
import { mergeRuns } from "../tests/runs.js";
import { applyMutations, entriesArb, mutationsArb, sameBytes } from "./mutate.js";
import { bounded, framedBlocks, RuleBroken, tally } from "./targets.js";
import { loadWasm, type FlatEngine } from "./wasm.js";

/**
 * Differential: the wasm engine against TypeScript
 * (docs/research/corruption-hardening-test-suite.md, technique 8), on the
 * same valid and mutated inputs. On valid inputs both must return the same
 * thing. On mutated inputs each must obey the rules of `targets.ts`; they
 * may differ in which error they throw, and where no CRC guards the bytes,
 * in their answer. Wasm must never trap: a trap is a panic, and traps
 * used up the instance (KW3 in findings.test.ts).
 *
 *   KV_FUZZ_RUNS=5000 KV_FUZZ_REPORT=1 pnpm exec vitest run fuzz/differential.test.ts
 */
const env = process.env;
const RUNS = Number(env.KV_FUZZ_RUNS ?? 300);
const params: fc.Parameters<unknown> = {
  numRuns: RUNS,
  ...(env.KV_FUZZ_SEED ? { seed: Number(env.KV_FUZZ_SEED), ...(env.KV_FUZZ_PATH ? { path: env.KV_FUZZ_PATH } : {}) } : {}),
};
const TIMEOUT = 60_000 + RUNS * 200;

let wasm: FlatEngine;
beforeAll(async () => {
  wasm = await loadWasm();
});
afterAll(() => {
  if (env.KV_FUZZ_REPORT) console.log([...tally].map(([k, n]) => `${k}: ${n}`).join("\n"));
});

const count = (what: string) => tally.set(what, (tally.get(what) ?? 0) + 1);

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

function attempt<T>(fn: () => T): Outcome<T> {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

/** A wasm call may throw CorruptDatabaseError, never a WebAssembly.RuntimeError. */
function wasmOutcome<T>(what: string, fn: () => T): Outcome<T> {
  const out = attempt(fn);
  if (!out.ok && out.error instanceof WebAssembly.RuntimeError) {
    throw new RuleBroken(`${what} trapped in wasm: ${out.error.message}`);
  }
  return out;
}

/** The TypeScript side may fail only with CorruptDatabaseError. */
function tsOutcome<T>(what: string, fn: () => T): Outcome<T> {
  const out = attempt(fn);
  if (!out.ok && !(out.error instanceof CorruptDatabaseError)) {
    throw new RuleBroken(`${what} threw ${String(out.error)}`);
  }
  return out;
}

type Codec = "raw" | "lz4";
const runArb = fc.record({ entries: entriesArb, codec: fc.constantFrom<Codec>("raw", "lz4"), blockTarget: fc.constantFrom(64, 512, 4096) });

async function encodeRun(r: { entries: SstEntry[]; codec: Codec; blockTarget: number }): Promise<Uint8Array> {
  return r.codec === "raw" ? encodeSst(r.entries, r.blockTarget) : encodeSstWasm(r.entries, "lz4");
}

const plain = (es: readonly { kind: string; key: Uint8Array; value?: Uint8Array; seq?: number }[]) =>
  es.map((e) => ({ kind: e.kind, key: [...e.key], value: e.value ? [...e.value] : undefined, seq: e.seq ?? 0 }));

/** Both block scans of one framed block: `scanBlockContains` and the TypeScript cursor a tab falls back to. */
async function scanBoth(framed: Uint8Array, lz4: boolean, pattern: Uint8Array): Promise<"same" | "differ" | "rejected"> {
  return bounded("scan_block_contains (both)", () => {
    const w = wasmOutcome("scanBlockContains", () => [...unpackHits(wasm.scanBlockContains(framed, lz4, packPatterns([pattern])))]);
    const t = tsOutcome("BlockEntries", () => {
      const b = blockBytes(framed, new DataView(framed.buffer, framed.byteOffset, framed.byteLength), 0, { offset: 0, length: framed.byteLength }, lz4 ? "lz4" : "raw");
      const walk = new BlockEntries(b);
      const out: { key: Uint8Array; value: Uint8Array }[] = [];
      for (let e = walk.next(); e; e = walk.next()) {
        if (out.length > 255 * framed.byteLength + 16) throw new RuleBroken("BlockEntries did not end");
        if (e.kind === "put" && contains(e.value!, pattern)) out.push({ key: e.key, value: e.value! });
      }
      return out;
    });
    if (!w.ok || !t.ok) return w.ok === t.ok ? "rejected" : "differ";
    const show = (hs: { key: Uint8Array; value: Uint8Array }[]) => hs.map((h) => [[...h.key], [...h.value]]);
    return JSON.stringify(show(w.value)) === JSON.stringify(show(t.value)) ? "same" : "differ";
  });
}

function contains(hay: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.byteLength <= hay.byteLength; i++) {
    for (let j = 0; j < needle.byteLength; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return needle.byteLength === 0;
}

const hot = new TextEncoder().encode(" hot");

describe("wasm against TypeScript", () => {
  it(
    "TypeScript decodes the runs either side encodes",
    async () => {
      await expect(
        fc.assert(
          fc.asyncProperty(runArb, async (r) => {
            const buf = await encodeRun(r);
            const sorted = [...r.entries].sort((a, b) => compareBytes(a.key, b.key));
            expect(plain(decodeSst(buf))).toEqual(plain(sorted));
          }),
          params,
        ),
      ).resolves.toBeUndefined();
    },
    TIMEOUT,
  );

  it(
    "scan the same blocks to the same hits, and survive mutated ones",
    async () => {
      let differ = 0;
      await expect(
        fc.assert(
          fc.asyncProperty(runArb, mutationsArb, fc.boolean(), fc.nat(), async (r, ms, mutate, pick) => {
            const buf = await encodeRun(r);
            const blocks = framedBlocks(buf);
            if (blocks.length === 0) return;
            const block = blocks[pick % blocks.length]!;
            const lz4 = r.codec === "lz4";
            if (!mutate) {
              expect(await scanBoth(block, lz4, hot)).toBe("same");
              return;
            }
            const got = await scanBoth(applyMutations(block, ms, buf), lz4, hot);
            count(`scan of a mutated block: ${got}`);
            if (got === "differ") differ++;
          }),
          params,
        ),
      ).resolves.toBeUndefined();
      // Where no CRC guards the bytes the two may answer differently; the
      // count is reported (KV_FUZZ_REPORT=1), not asserted.
      expect(differ).toBeGreaterThanOrEqual(0);
    },
    TIMEOUT,
  );

  it(
    "unpack the same LZ4 blocks to the same bytes",
    async () => {
      await expect(
        fc.assert(
          fc.asyncProperty(entriesArb, mutationsArb, fc.boolean(), fc.nat(), async (entries, ms, mutate, pick) => {
            const blocks = framedBlocks(await encodeSstWasm(entries, "lz4"));
            if (blocks.length === 0) return;
            const block = blocks[pick % blocks.length]!;
            const size = new DataView(block.buffer, block.byteOffset).getUint32(0, true);
            const src = mutate ? applyMutations(block.subarray(4), ms, block) : block.subarray(4);
            await bounded("lz4 (both)", () => {
              const w = wasmOutcome("lz4Decompress", () => wasm.lz4Decompress(src, size));
              const t = tsOutcome("lz4DecompressJs", () => lz4DecompressJs(src, size));
              if (!mutate) expect(w.ok && t.ok).toBe(true);
              if (w.ok && t.ok) expect(sameBytes(w.value, t.value)).toBe(true);
              count(`lz4: ${w.ok ? "wasm ok" : "wasm rejected"}, ${t.ok ? "ts ok" : "ts rejected"}`);
            });
          }),
          params,
        ),
      ).resolves.toBeUndefined();
    },
    TIMEOUT,
  );

  it(
    "merge the same runs to the same entries",
    async () => {
      const openWasm = (spec: MergeSpec) => {
        const core = wasm.openMerge(spec);
        if (!core) throw new Error("the test engine already holds a session");
        return core;
      };
      await expect(
        fc.assert(
          fc.asyncProperty(fc.array(runArb, { minLength: 1, maxLength: 4 }), fc.boolean(), fc.constantFrom(64, 1024, Number.MAX_SAFE_INTEGER), async (runs, drop, target) => {
            const sources = (await Promise.all(runs.map(encodeRun))).map((run) => [run]);
            const options = { dropTombstones: drop, targetBytes: target };
            const w = await mergeRuns(sources, { ...options, open: openWasm });
            const t = await mergeRuns(sources, { ...options, open: openMergeTs });
            const flat = async (out: readonly EncodedRun[]) => plain(out.flatMap((r) => decodeSst(r.body)));
            expect(await flat(w.runs)).toEqual(await flat(t.runs));
            expect(w.droppedSeq).toBe(t.droppedSeq);
            // Raw runs cut blocks and runs in the same places (design.md), so the bytes match too.
            expect(w.runs.map((r) => [...r.body])).toEqual(t.runs.map((r) => [...r.body]));
            // And both report the same size and key range at the end of each run.
            expect(w.runs.map((r) => r.end)).toEqual(t.runs.map((r) => r.end));
          }),
          { ...params, numRuns: Math.ceil(RUNS / 10) },
        ),
      ).resolves.toBeUndefined();
    },
    TIMEOUT,
  );
});

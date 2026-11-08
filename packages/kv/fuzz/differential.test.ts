import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { compareBytes } from "../src/bytes.js";
import { CorruptDatabaseError } from "../src/errors.js";
import { packPatterns, unpackHits } from "../src/store/block-scan.js";
import { encodeSst as encodeSstWasm, mergeSsts } from "../src/store/engine.js";
import { lz4DecompressJs } from "../src/store/lz4.js";
import { BlockEntries, blockBytes, decodeSst, encodeSst, type SstEntry } from "../src/store/sst.js";
import { applyMutations, entriesArb, mutationsArb, sameBytes } from "./mutate.js";
import { bounded, footerOf, framedBlocks, knownError, knownSstBug, lz4SizeUnbounded, repairSst, RuleBroken, tally, type Repair } from "./targets.js";
import { loadWasm, type WasmExports } from "./wasm.js";

/**
 * Differential: the wasm engine against the TypeScript fallbacks
 * (docs/research/corruption-hardening-test-suite.md, technique 8), on the
 * same valid and mutated inputs. On valid inputs both must return the same
 * thing. On mutated inputs each must obey the rules of `targets.ts`; they
 * may differ in which error they throw, and where no CRC guards the bytes,
 * in their answer. Wasm must never trap: a trap is a Rust panic, and traps
 * use up the instance (KW3 in known-bugs.test.ts).
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
const includeKnown = env.KV_FUZZ_KNOWN === "1";

let wasm: WasmExports;
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

/** A wasm call may fail with the Rust error as a string, never trap. */
function wasmOutcome<T>(what: string, fn: () => T): Outcome<T> {
  const out = attempt(fn);
  if (!out.ok && out.error instanceof WebAssembly.RuntimeError) {
    throw new RuleBroken(`${what} trapped in wasm: ${out.error.message}`);
  }
  return out;
}

/** The TypeScript side may fail only with CorruptDatabaseError (or a reported bug). */
function tsOutcome<T>(what: string, fn: () => T): Outcome<T> {
  const out = attempt(fn);
  if (!out.ok && !(out.error instanceof CorruptDatabaseError) && !knownError(out.error)) {
    throw new RuleBroken(`${what} threw ${String(out.error)}`);
  }
  return out;
}

/**
 * KW1: a varint near 2^32 wraps `o + len` on wasm32 and the slice after it
 * panics. Skipped (unless `KV_FUZZ_KNOWN=1`) so the run goes on.
 */
function hugeVarint(b: Uint8Array): boolean {
  for (let i = 0; i + 4 < b.byteLength; i++) {
    if (b[i + 4] === 0x0f && b[i]! >= 0x80 && b[i + 1]! >= 0x80 && b[i + 2]! >= 0x80 && b[i + 3]! >= 0x80) return true;
  }
  return false;
}

/** The unpacked bytes of a framed block, when they can be had in bounds. */
function unpacked(framed: Uint8Array, lz4: boolean): Uint8Array | undefined {
  if (!lz4) return framed;
  if (framed.byteLength < 4 || lz4SizeUnbounded(framed)) return undefined;
  try {
    return lz4DecompressJs(framed.subarray(4), new DataView(framed.buffer, framed.byteOffset).getUint32(0, true));
  } catch {
    return undefined;
  }
}

/** Inputs that reach a reported wasm bug, told apart before the call. */
function knownWasmBug(buf: Uint8Array): string | undefined {
  if (includeKnown) return undefined;
  const id = knownSstBug(buf);
  if (id) return id;
  const f = footerOf(buf);
  if (f && f.entryCount > buf.byteLength) return "KB2";
  const lz4 = f?.codec === 1;
  // Past the CRC, `decode_blocks` and `read_records` wrap the same way as KW1.
  if (hugeVarint(buf) || framedBlocks(buf).some((b) => hugeVarint(unpacked(b, lz4) ?? new Uint8Array()))) return "KW1";
  if (f && wrapsOnWasm32(buf)) return "KW1";
  return undefined;
}

/** An index entry or footer sum that passes 2^32, which wraps on wasm32. */
function wrapsOnWasm32(buf: Uint8Array): boolean {
  const f = footerOf(buf)!;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const at = buf.byteLength - 44;
  const field = (i: number) => view.getUint32(at + 4 * i, true);
  if (field(2) + field(3) >= 2 ** 32 || field(5) + field(6) >= 2 ** 32) return true;
  let o = f.indexStart;
  for (let i = 0; i < Math.min(f.blockCount, 4096); i++) {
    for (let k = 0; k < 2; k++) {
      if (o + 4 > buf.byteLength) return false;
      const len = view.getUint32(o, true);
      if (o + 4 + len >= 2 ** 32) return true;
      o += 4 + len;
    }
    if (o + 8 > buf.byteLength) return false;
    if (view.getUint32(o, true) + view.getUint32(o + 4, true) >= 2 ** 32) return true;
    o += 8;
  }
  return false;
}

type Codec = "raw" | "lz4";
const runArb = fc.record({ entries: entriesArb, codec: fc.constantFrom<Codec>("raw", "lz4"), blockTarget: fc.constantFrom(64, 512, 4096) });
const repairArb = fc.constantFrom<Repair>("none", "crc", "trailer");

async function encodeRun(r: { entries: SstEntry[]; codec: Codec; blockTarget: number }): Promise<Uint8Array> {
  return r.codec === "raw" ? encodeSst(r.entries, r.blockTarget) : encodeSstWasm(r.entries, "lz4");
}

const plain = (es: readonly { kind: string; key: Uint8Array; value?: Uint8Array; seq?: number }[]) =>
  es.map((e) => ({ kind: e.kind, key: [...e.key], value: e.value ? [...e.value] : undefined, seq: e.seq ?? 0 }));

/** Both decoders of a whole run. The wasm one is what the SharedWorker runs. */
async function decodeBoth(buf: Uint8Array, changed: boolean): Promise<void> {
  if (knownWasmBug(buf)) {
    count("skipped (known wasm bug)");
    return;
  }
  await bounded("decode_sst (both)", () => {
    const w = wasmOutcome("decode_sst_js", () => wasm.decode_sst_js(buf));
    const t = tsOutcome("decodeSst", () => decodeSst(buf));
    if (changed && (w.ok || t.ok)) throw new RuleBroken(`${w.ok ? "wasm" : "TypeScript"} decoded a run whose bytes changed under its CRC`);
    if (w.ok && t.ok) {
      expect(plain(w.value)).toEqual(plain(t.value));
      count("decode: both decoded, same entries");
    } else if (w.ok !== t.ok) {
      // Only past a rewritten CRC: bytes written on purpose.
      count(`decode: only ${w.ok ? "wasm" : "TypeScript"} decoded (CRC rewritten)`);
    } else count("decode: both rejected");
  });
}

/** Both block scans of one framed block: `scan_block_contains_js` and the TypeScript cursor a tab falls back to. */
async function scanBoth(framed: Uint8Array, lz4: boolean, pattern: Uint8Array, mutated: boolean): Promise<"same" | "differ" | "rejected"> {
  if (mutated && !includeKnown) {
    if (lz4 && lz4SizeUnbounded(framed)) return "rejected";
    if (hugeVarint(unpacked(framed, lz4) ?? framed)) {
      count("skipped (known wasm bug)");
      return "rejected";
    }
  }
  return bounded("scan_block_contains (both)", () => {
    const w = wasmOutcome("scan_block_contains_js", () => [...unpackHits(wasm.scan_block_contains_js(framed, lz4, packPatterns([pattern])))]);
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

describe("wasm against the TypeScript fallbacks", () => {
  it(
    "decode the same runs to the same entries",
    async () => {
      await expect(
        fc.assert(
          fc.asyncProperty(runArb, async (r) => {
            const buf = await encodeRun(r);
            await decodeBoth(buf, false);
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
    "both reject a run changed under its CRC, and neither breaks a rule past a rewritten one",
    async () => {
      await expect(
        fc.assert(
          fc.asyncProperty(runArb, runArb, mutationsArb, repairArb, async (r, o, ms, repair) => {
            const orig = await encodeRun(r);
            const other = await encodeRun(o);
            const buf = applyMutations(orig, ms, other);
            repairSst(buf, repair);
            await decodeBoth(buf, repair === "none" && !sameBytes(buf, orig) && !sameBytes(buf, other));
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
              expect(await scanBoth(block, lz4, hot, false)).toBe("same");
              return;
            }
            const got = await scanBoth(applyMutations(block, ms, buf), lz4, hot, true);
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
              const w = wasmOutcome("lz4_decompress_js", () => wasm.lz4_decompress_js(src, size));
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
      await expect(
        fc.assert(
          fc.asyncProperty(fc.array(runArb, { minLength: 1, maxLength: 4 }), fc.boolean(), fc.constantFrom(64, 1024, Number.MAX_SAFE_INTEGER), async (runs, drop, target) => {
            const blobs = await Promise.all(runs.map(encodeRun));
            const w = await mergeSsts(blobs, drop, target, "raw");
            const t = await mergeSstsTs(blobs, drop, target);
            const flat = async (ssts: readonly Uint8Array[]) => plain(ssts.flatMap((s) => decodeSst(s)));
            expect(await flat(w.ssts)).toEqual(await flat(t.ssts));
            expect(w.droppedSeq).toBe(t.droppedSeq);
            // Raw runs cut blocks and runs in the same places (design.md), so the bytes match too.
            expect(w.ssts.map((s) => [...s])).toEqual(t.ssts.map((s) => [...s]));
          }),
          { ...params, numRuns: Math.ceil(RUNS / 10) },
        ),
      ).resolves.toBeUndefined();
    },
    TIMEOUT,
  );
});

/**
 * `mergeSsts` as it runs when wasm does not load: a fresh copy of engine.ts
 * whose wasm import fails, so no product seam is needed.
 */
async function mergeSstsTs(blobs: readonly Uint8Array[], drop: boolean, target: number) {
  fallback ??= (async () => {
    vi.resetModules();
    vi.doMock("../wasm/engine_wasm.js", () => {
      throw new Error("wasm disabled for the differential test");
    });
    const engine = await import("../src/store/engine.js");
    await engine.ensureEngine();
    vi.doUnmock("../wasm/engine_wasm.js");
    if (engine.engineUsingWasm()) throw new Error("the fallback engine loaded wasm");
    return engine;
  })();
  return (await fallback).mergeSsts(blobs, drop, target, "raw");
}
let fallback: Promise<typeof import("../src/store/engine.js")> | undefined;

import { beforeAll, describe, expect, it, vi } from "vitest";
import { CorruptDatabaseError } from "../src/errors.js";
import { packPatterns } from "../src/store/block-scan.js";
import { decodeSst as decodeSstEngine } from "../src/store/engine.js";
import { decodeGeneration, encodeGeneration } from "../src/store/generation.js";
import { lz4Decompress } from "../src/store/lz4.js";
import { PageCache } from "../src/store/page-cache.js";
import { bytesFile, SstReader } from "../src/store/sst-reader.js";
import { decodeSst, encodeSst, readFooter } from "../src/store/sst.js";
import { settle } from "../src/store/cursor.js";
import { mergeRuns } from "../tests/runs.js";
import { bounded, fixManifestCrc, fixSstCrc, RuleBroken } from "./targets.js";
import { loadWasm, withoutWasm, type FlatEngine } from "./wasm.js";

/**
 * Bugs the decoder fuzzing found, each reduced to one input and kept as a
 * regression test that states the rule. The Rust side keeps KB1 and KB2 in
 * crates/engine-core/tests/corrupt_inputs.rs, and R1 and R2 are in
 * tests/sim/corruption.test.ts.
 */

const utf = (s: string) => new TextEncoder().encode(s);
let wasm: FlatEngine;

beforeAll(async () => {
  wasm = await loadWasm();
});

const entries = Array.from({ length: 40 }, (_, i) => ({
  kind: "put" as const,
  key: utf(`k${String(i).padStart(3, "0")}`),
  value: utf(`value ${i}`),
  seq: i + 1,
}));
const footer = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset + b.byteLength - 44, 44);
const range = { smallest: entries[0]!.key, largest: entries[entries.length - 1]!.key };

/** A tab's get of `key` from run bytes `buf`, as `SstReader` does it. */
async function tabGet(buf: Uint8Array, key: Uint8Array) {
  const reader = new SstReader(bytesFile(buf), new PageCache(), range);
  return settle(() => reader.get(key));
}

/**
 * The call must end in bounds and throw only CorruptDatabaseError. A GC
 * during the call can hide an allocation from `bounded`, which would let a
 * pinned bug pass, so the call runs a few times and any broken rule counts.
 */
async function corruptWithinBounds(what: string, fn: () => unknown): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    await bounded(what, async () => {
      try {
        await fn();
      } catch (err) {
        if (err instanceof CorruptDatabaseError) return;
        throw new RuleBroken(`${what} threw ${err instanceof Error ? `${err.name}: ${err.message}` : `a ${typeof err}`}`);
      }
    });
  }
}

describe("decoder bugs the fuzzers found", () => {
  // KB1, tab path. An LZ4 block's u32 uncompressed size was allocated before
  // it was decoded: `lz4_flex::block::decompress` does `vec![0; size]` in wasm,
  // `lz4DecompressJs` did `new Uint8Array(size)`. Tabs check no CRC, so one
  // corrupt size in an L2+ run grew the tab's wasm memory by up to 4 GiB,
  // for good (wasm memory never shrinks). Found by "a tab reads any mutation
  // of a run" and the scan_block_contains cargo-fuzz target. Both decoders
  // now refuse a size past 255 times the compressed bytes first.
  it("KB1: a corrupt LZ4 block size does not size an allocation (wasm)", async () => {
    await expect(corruptWithinBounds("lz4Decompress (wasm)", () => lz4Decompress(new Uint8Array([0x10, 0x41]), 0x08000000))).resolves.toBeUndefined();
  });

  it("KB1: a corrupt LZ4 block size does not size an allocation (TypeScript)", async () => {
    await expect(
      withoutWasm(() => corruptWithinBounds("lz4Decompress (TypeScript)", () => lz4Decompress(new Uint8Array([0x10, 0x41]), 0x08000000))),
    ).resolves.toBeUndefined();
  });

  // KT1, tab path. `bloomMightContain` loops `hashCount` times, and
  // `readFooter` took the count from the footer unchecked. On a saturated
  // filter each get of a key in range costs ~30 ns per round: a corrupt
  // count near 2^32 made one get take about two minutes. The encoder
  // always writes 7; `readFooter` now refuses more than 32.
  it("KT1: a corrupt bloom hash count does not make a get loop", async () => {
    const buf = encodeSst(entries);
    const f = readFooter(buf, buf.byteLength);
    buf.fill(0xff, f.dataLen, f.indexStart);
    footer(buf).setUint32(16, 5_000_000, true);
    const t0 = performance.now();
    await tabGet(buf, utf("k0005")).catch(() => undefined);
    // A healthy get takes microseconds; this count cost ~0.3 s, 2^32 ~2 min.
    expect(performance.now() - t0).toBeLessThan(50);
  });

  // KT2, tab path. `packIndex` allocates `sepEnd` and `blockStart`
  // (Uint32Array) from the footer's block count before it reads the index:
  // a count of 2^24 cost 128 MiB, and one near 2^32 asked for 32 GiB. One
  // flipped bit in the count's high byte was enough. `readFooter` now
  // refuses a count whose 16-byte index entries pass the index length.
  it("KT2: a corrupt block count does not size an allocation", async () => {
    const buf = encodeSst(entries);
    footer(buf).setUint32(4, 0x01000000, true);
    await expect(corruptWithinBounds("SstReader.get", () => tabGet(buf, utf("k001")))).resolves.toBeUndefined();
  });

  // KT3, SharedWorker without wasm, past the CRC only: bytes written on
  // purpose. `readBlockIndex` (decodeSst, sstKeyRange) read the index with
  // no bounds checks, so a CRC-valid run with a bad index threw a
  // RangeError from DataView instead of CorruptDatabaseError.
  it("KT3: decodeSst throws CorruptDatabaseError on a CRC-valid run with a bad index", async () => {
    const buf = encodeSst(entries);
    const f = readFooter(buf, buf.byteLength);
    new DataView(buf.buffer).setUint32(f.indexStart, 0x7fffffff, true);
    fixSstCrc(buf);
    await expect(corruptWithinBounds("decodeSst", () => decodeSst(buf))).resolves.toBeUndefined();
  });

  // KT4, tabs and the SharedWorker, past the CRC only. `decodeGeneration`
  // read run entries with no bounds checks.
  it("KT4: decodeGeneration throws CorruptDatabaseError on a CRC-valid manifest with a bad length", async () => {
    const m = encodeGeneration({
      generation: 1,
      tombstoneSeq: 0,
      through: 0,
      runs: [{ path: "l1/a.sst", bytes: 100, range: { smallest: utf("a"), largest: utf("b") } }],
    });
    // Run count and the first path length, inflated (found by "manifests ... reject every change").
    new DataView(m.buffer).setUint32(34, 0xffffffff, true);
    fixManifestCrc(m);
    await expect(corruptWithinBounds("decodeGeneration", () => decodeGeneration(m))).resolves.toBeUndefined();
  });

  // KW1, tab path (`range({ valueContains })`). On wasm32 `usize` is 32 bits
  // and release builds wrap, so `o + key_len > end` passed for a varint near
  // 2^32 and the slice after it panicked: the wasm instance trapped
  // (RuntimeError: unreachable). The same sums were in `read_records` and
  // `decode_blocks`. 64-bit cargo fuzz cannot see it; the differential test
  // does. The checks are now `key_len > end - o`, with `o <= end`.
  it("KW1: scan_block_contains does not panic on a varint near 2^32", () => {
    const block = new Uint8Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0xf0, 0xff, 0xff, 0xff, 0x0f, 1, 2, 3]);
    expect(() => wasm.scanBlockContains(block, false, packPatterns([]))).not.toThrow(WebAssembly.RuntimeError);
  });

  // KB2 in wasm, past the CRC only: `decode_sst` reserved the footer's
  // entry count, which overflowed capacity on wasm32 and panicked.
  it("KB2: decode_sst does not panic on a CRC-valid run with a huge entry count", () => {
    const buf = encodeSst(entries);
    footer(buf).setUint32(0, 0xffffffff, true);
    fixSstCrc(buf);
    expect(() => wasm.decodeSst(buf)).not.toThrow(WebAssembly.RuntimeError);
  });

  // KW2, SharedWorker with wasm. `decode_sst_js` and `merge_ssts_js` threw
  // the Rust error as a bare string ("CrcMismatch"). `engine.decodeSst` and
  // the compaction merge passed it on, so a compaction over a corrupt run
  // failed with a string, not CorruptDatabaseError. They now wrap it, and
  // the port carries the error's code so the tab rethrows the same class.
  it("KW2: a compaction over a run with a bad CRC throws CorruptDatabaseError", async () => {
    const buf = encodeSst(entries);
    buf[5]! ^= 1;
    await expect(corruptWithinBounds("merge session", () => mergeRuns([[buf]]))).resolves.toBeUndefined();
  });

  it("KW2: decodeSst (engine) over a run with a bad CRC throws CorruptDatabaseError", async () => {
    const buf = encodeSst(entries);
    buf[5]! ^= 1;
    await expect(corruptWithinBounds("decodeSst", () => decodeSstEngine(buf))).resolves.toBeUndefined();
  });
});

describe("wasm traps", () => {
  // KW3, tabs and the SharedWorker. A wasm panic traps without unwinding,
  // so the frames of the trapped call stay on the shadow stack. After
  // ~3,000-4,000 panics (KW1 or KB2 inputs, e.g. a `valueContains` scan an
  // app repeats over one corrupt block) the stack was used up and every
  // wasm call trapped with "memory access out of bounds". Input no longer
  // panics, and after any trap engine.ts drops wasm for the context.
  it("KW3: valid calls still work after many calls that used to panic", () => {
    const block = new Uint8Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0xf0, 0xff, 0xff, 0xff, 0x0f, 1, 2, 3]);
    for (let i = 0; i < 5_000; i++) {
      try {
        wasm.scanBlockContains(block, false, packPatterns([]));
      } catch {
        // KW1 panicked here.
      }
    }
    const run = encodeSst(entries);
    expect(wasm.decodeSst(run)).toHaveLength(entries.length);
  });

  // A trap that is not a panic on input: wasm memory cannot grow to 4 GiB.
  // The engine drops wasm for this context and answers in TypeScript, so
  // one trap never poisons later calls.
  it("KW3: after a trap the engine drops wasm and keeps answering", async () => {
    vi.resetModules();
    const engine = await import("../src/store/engine.js");
    const lz4 = await import("../src/store/lz4.js");
    const errors = await import("../src/errors.js");
    await engine.ensureEngine();
    expect(engine.engineUsingWasm()).toBe(true);
    const src = new Uint8Array(17_000_000);
    expect(() => lz4.lz4Decompress(src, 0xfffffff0)).toThrow(errors.CorruptDatabaseError);
    expect(engine.engineUsingWasm()).toBe(false);
    const run = await engine.encodeSst(entries);
    expect(await engine.decodeSst(run)).toHaveLength(entries.length);
    vi.resetModules();
  });
});

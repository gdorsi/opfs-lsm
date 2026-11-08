import { beforeAll, describe, expect, it } from "vitest";
import { CorruptDatabaseError } from "../src/errors.js";
import { packPatterns } from "../src/store/block-scan.js";
import { decodeSst as decodeSstEngine, mergeSsts } from "../src/store/engine.js";
import { decodeGeneration, encodeGeneration } from "../src/store/generation.js";
import { lz4Decompress } from "../src/store/lz4.js";
import { PageCache } from "../src/store/page-cache.js";
import { bytesFile, SstReader } from "../src/store/sst-reader.js";
import { decodeSst, encodeSst, readFooter } from "../src/store/sst.js";
import { settle } from "../src/store/cursor.js";
import { bounded, fixManifestCrc, fixSstCrc, RuleBroken } from "./targets.js";
import { loadWasm, withoutWasm, type WasmExports } from "./wasm.js";

/**
 * Bugs the decoder fuzzing found, each reduced to one input. They are
 * reported, not fixed: each test states the rule and is marked `it.fails`
 * while the engine breaks it. A fix makes its test fail; then drop the
 * `.fails` and the matching clause of `KNOWN`/`knownError` in targets.ts.
 * The Rust side pins KB1 and KB2 in crates/engine-core/tests/corrupt_inputs.rs.
 */

const utf = (s: string) => new TextEncoder().encode(s);
let wasm: WasmExports;

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

describe("known decoder bugs (reported, not fixed)", () => {
  // KB1, tab path. An LZ4 block's u32 uncompressed size is allocated before
  // it is decoded: `lz4_flex::block::decompress` does `vec![0; size]` in wasm,
  // `lz4DecompressJs` does `new Uint8Array(size)`. Tabs check no CRC, so one
  // corrupt size in an L2+ run grows the tab's wasm memory by up to 4 GiB,
  // for good (wasm memory never shrinks). Found by "a tab reads any mutation
  // of a run" and the scan_block_contains cargo-fuzz target.
  // Candidate fix: in `blockBytes`, `lz4_decompress_js`, `scan_block_contains`
  // and `decode_blocks`, reject `size > 255 * compressed + 16` as corrupt.
  it.fails("KB1: a corrupt LZ4 block size does not size an allocation (wasm)", async () => {
    await expect(corruptWithinBounds("lz4Decompress (wasm)", () => lz4Decompress(new Uint8Array([0x10, 0x41]), 0x08000000))).resolves.toBeUndefined();
  });

  it.fails("KB1: a corrupt LZ4 block size does not size an allocation (TypeScript)", async () => {
    await expect(
      withoutWasm(() => corruptWithinBounds("lz4Decompress (TypeScript)", () => lz4Decompress(new Uint8Array([0x10, 0x41]), 0x08000000))),
    ).resolves.toBeUndefined();
  });

  // KT1, tab path. `bloomMightContain` loops `hashCount` times, and
  // `readFooter` takes the count from the footer unchecked. On a saturated
  // filter each get of a key in range costs ~30 ns per round: a corrupt
  // count near 2^32 makes one get take about two minutes. The encoder
  // always writes 7.
  // Candidate fix: `readFooter` rejects `bloomHashCount > 32` as corrupt.
  it.fails("KT1: a corrupt bloom hash count does not make a get loop", async () => {
    const buf = encodeSst(entries);
    const f = readFooter(buf, buf.byteLength);
    buf.fill(0xff, f.dataLen, f.indexStart);
    footer(buf).setUint32(16, 5_000_000, true);
    const t0 = performance.now();
    await tabGet(buf, utf("k0005")).catch(() => undefined);
    // A healthy get takes microseconds; this count costs ~0.3 s, 2^32 ~2 min.
    expect(performance.now() - t0).toBeLessThan(50);
  });

  // KT2, tab path. `packIndex` allocates `sepEnd` and `blockStart`
  // (Uint32Array) from the footer's block count before it reads the index:
  // a count of 2^24 costs 128 MiB, and one near 2^32 asks for 32 GiB, which
  // Node grants lazily (not tried in a browser). One flipped bit in the
  // count's high byte is enough.
  // Candidate fix: in `openMeta`, reject `blockCount * 16 > indexLen`
  // (an index entry is at least 16 bytes) as corrupt.
  it.fails("KT2: a corrupt block count does not size an allocation", async () => {
    const buf = encodeSst(entries);
    footer(buf).setUint32(4, 0x01000000, true);
    await expect(corruptWithinBounds("SstReader.get", () => tabGet(buf, utf("k001")))).resolves.toBeUndefined();
  });

  // KT3, SharedWorker without wasm, past the CRC only: bytes written on
  // purpose. `readBlockIndex` (decodeSst, sstKeyRange) reads the index with
  // no bounds checks, so a CRC-valid run with a bad index throws a
  // RangeError from DataView instead of CorruptDatabaseError.
  // Candidate fix: bounds-check like `packIndex` does.
  it.fails("KT3: decodeSst throws CorruptDatabaseError on a CRC-valid run with a bad index", async () => {
    const buf = encodeSst(entries);
    const f = readFooter(buf, buf.byteLength);
    new DataView(buf.buffer).setUint32(f.indexStart, 0x7fffffff, true);
    fixSstCrc(buf);
    await expect(corruptWithinBounds("decodeSst", () => decodeSst(buf))).resolves.toBeUndefined();
  });

  // KT4, tabs and the SharedWorker, past the CRC only. `decodeGeneration`
  // reads run entries with no bounds checks.
  // Candidate fix: check `o + n <= crcOff` before each read, as decodeOps does.
  it.fails("KT4: decodeGeneration throws CorruptDatabaseError on a CRC-valid manifest with a bad length", async () => {
    const m = encodeGeneration({
      generation: 1,
      tombstoneSeq: 0,
      through: 0,
      runs: [{ path: "l1/a.sst", range: { smallest: utf("a"), largest: utf("b") } }],
    });
    // Run count and the first path length, inflated (found by "manifests ... reject every change").
    new DataView(m.buffer).setUint32(34, 0xffffffff, true);
    fixManifestCrc(m);
    await expect(corruptWithinBounds("decodeGeneration", () => decodeGeneration(m))).resolves.toBeUndefined();
  });

  // KW1, tab path (`range({ valueContains })`). On wasm32 `usize` is 32 bits
  // and release builds wrap, so `o + key_len > end` passes for a varint near
  // 2^32 and the slice after it panics: the wasm instance traps
  // (RuntimeError: unreachable). The block scanner wraps the trap in
  // CorruptDatabaseError, so the read fails as corrupt, but a panic in wasm
  // breaks the rule. The same unchecked sums are in `read_records` and
  // `decode_blocks` (`decode_sst`, past the CRC). 64-bit cargo fuzz cannot
  // see it; the differential test does.
  // Candidate fix: `key_len > end - o` (and the same for values, prefixes
  // and `start + length`) instead of `o + key_len > end`.
  it.fails("KW1: scan_block_contains does not panic on a varint near 2^32", () => {
    const block = new Uint8Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0xf0, 0xff, 0xff, 0xff, 0x0f, 1, 2, 3]);
    expect(() => wasm.scan_block_contains_js(block, false, packPatterns([]))).not.toThrow(WebAssembly.RuntimeError);
  });

  // KB2 in wasm, past the CRC only: `decode_sst` reserves the footer's
  // entry count, which overflows capacity on wasm32 and panics.
  it.fails("KB2: decode_sst does not panic on a CRC-valid run with a huge entry count", () => {
    const buf = encodeSst(entries);
    footer(buf).setUint32(0, 0xffffffff, true);
    fixSstCrc(buf);
    expect(() => wasm.decode_sst_js(buf)).not.toThrow(WebAssembly.RuntimeError);
  });

  // KW2, SharedWorker with wasm. `decode_sst_js` and `merge_ssts_js` throw
  // the Rust error as a bare string ("CrcMismatch"), and a panic as
  // RuntimeError. `engine.decodeSst` and `mergeSsts` pass it on, so a
  // compaction over a corrupt run fails with a string, not
  // CorruptDatabaseError (the TypeScript fallback throws
  // CorruptDatabaseError). Over the SharedWorker port every host error
  // becomes a plain Error anyway (`createPortIngestClient`).
  // Candidate fix: wrap both calls like the block scanner does.
  it.fails("KW2: a compaction over a run with a bad CRC throws CorruptDatabaseError", async () => {
    const buf = encodeSst(entries);
    buf[5]! ^= 1;
    await expect(corruptWithinBounds("mergeSsts", () => mergeSsts([buf], false))).resolves.toBeUndefined();
  });

  it.fails("KW2: decodeSst (engine) over a run with a bad CRC throws CorruptDatabaseError", async () => {
    const buf = encodeSst(entries);
    buf[5]! ^= 1;
    await expect(corruptWithinBounds("decodeSst", () => decodeSstEngine(buf))).resolves.toBeUndefined();
  });
});

describe("wasm panics", () => {
  // KW3, tabs and the SharedWorker. A wasm panic traps without unwinding,
  // so the frames of the trapped call stay on the shadow stack. After
  // ~3,000-4,000 panics (KW1 or KB2 inputs, e.g. a `valueContains` scan an
  // app repeats over one corrupt block) the stack is used up and every wasm
  // call traps with "memory access out of bounds": healthy LZ4 runs then
  // read as corrupt (`lz4Decompress` maps any wasm error to
  // CorruptDatabaseError) and every compaction fails.
  // Candidate fix: no panics on input (KW1, KB2), and in engine.ts drop the
  // instance after a RuntimeError and load a fresh one (or fall back to
  // TypeScript).
  it.fails("KW3: valid calls still work after many panics", () => {
    const block = new Uint8Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0xf0, 0xff, 0xff, 0xff, 0x0f, 1, 2, 3]);
    for (let i = 0; i < 5_000; i++) {
      try {
        wasm.scan_block_contains_js(block, false, packPatterns([]));
      } catch {
        // KW1 panics here.
      }
    }
    const run = encodeSst(entries);
    expect(wasm.decode_sst_js(run)).toHaveLength(entries.length);
  });
});

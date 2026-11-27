import { beforeAll, describe, expect, it, vi } from "vitest";
import { CorruptDatabaseError } from "../src/errors.js";
import { encodeRunIn, packPatterns, scanBlockContainsIn } from "../src/store/engine.js";
import { decodeGeneration, encodeGeneration } from "../src/store/generation.js";
import { PageCache } from "../src/store/page-cache.js";
import { SstReader } from "../src/store/sst-reader.js";
import { readFooter, SST_FOOTER_BYTES, type RunEnd } from "../src/store/sst.js";
import { decodeSst, encodeSstRef, sstRunEnd } from "../tests/oracle/sst-ref.js";
import { bytesFile, loadsDone, mergeRuns, NO_BLOCKS, runGet } from "../tests/runs.js";
import { blocksOf, bounded, fixIndexCrc, fixManifestCrc, fixSstCrc, RuleBroken } from "./targets.js";
import { loadWasm, type FlatEngine } from "./wasm.js";
import { NO_MARKS } from "../src/store/marks.js";

/**
 * Bugs the decoder fuzzing found, each reduced to one input and kept as a
 * regression test that states the rule. R1 and R2 are in
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
const footer = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset + b.byteLength - SST_FOOTER_BYTES, SST_FOOTER_BYTES);
/** What the manifest records for the run of `entries`. */
const recorded = sstRunEnd(encodeSstRef(entries));

/**
 * A tab's get of `key` from run bytes `buf`, as `SstReader` does it, asked
 * again once the load of the Bloom filter has ended: the first get does not
 * wait for the footer, and the second asks the filter when it loaded.
 */
async function tabGet(buf: Uint8Array, key: Uint8Array, run: RunEnd = recorded) {
  const cache = new PageCache();
  const reader = new SstReader(bytesFile(buf), cache, run);
  await runGet(reader, key);
  await loadsDone(cache);
  return runGet(reader, key);
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
  // KT1, tab path. `bloomMightContain` loops `hashCount` times, and
  // `readFooter` took the count from the footer unchecked. On a saturated
  // filter each get of a key in range costs ~30 ns per round: a corrupt
  // count near 2^32 made one get take about two minutes. The encoder
  // always writes 7; `readFooter` now refuses more than 32.
  it("KT1: a corrupt bloom hash count does not make a get loop", async () => {
    const buf = encodeSstRef(entries);
    const f = readFooter(buf, buf.byteLength);
    buf.fill(0xff, f.dataLen, buf.byteLength - SST_FOOTER_BYTES);
    footer(buf).setUint32(8, 5_000_000, true);
    const t0 = performance.now();
    await tabGet(buf, utf("k0005")).catch(() => undefined);
    // A healthy get takes microseconds; this count cost ~0.3 s, 2^32 ~2 min.
    expect(performance.now() - t0).toBeLessThan(50);
  });

  // KT2, tab path. A tab sized `sepEnd` and `blockStart` (Uint32Array) from
  // a block count before it read the index: a count of 2^24 cost 128 MiB,
  // and one near 2^32 asked for 32 GiB. One flipped bit in the count's high
  // byte was enough. The count is in the run's index, which the manifest
  // holds, and the index's decoder refuses a count its bytes cannot hold.
  it("KT2: a corrupt block count does not size an allocation", async () => {
    const buf = encodeSstRef(entries);
    const index = recorded.index.slice();
    new DataView(index.buffer).setUint32(0, 0x01000000, true);
    fixIndexCrc(index);
    await expect(corruptWithinBounds("SstReader.get", () => tabGet(buf, utf("k001"), { ...recorded, index }))).resolves.toBeUndefined();
  });

  // KT3, the whole-file decode, past the CRC only: bytes written on
  // purpose. `decodeSst` and `sstKeyRange` read a run's structure with no
  // bounds checks, so a CRC-valid run with a bad length threw a RangeError
  // from DataView instead of CorruptDatabaseError.
  it("KT3: decodeSst throws CorruptDatabaseError on a CRC-valid run with a bad block", async () => {
    const buf = encodeSstRef(entries);
    new DataView(buf.buffer).setUint32(0, 0x7fffffff, true);
    fixSstCrc(buf);
    await expect(corruptWithinBounds("decodeSst", () => decodeSst(buf))).resolves.toBeUndefined();
  });

  // KT4, tabs and the SharedWorker, past the CRC only. `decodeGeneration`
  // read run entries with no bounds checks.
  it("KT4: decodeGeneration throws CorruptDatabaseError on a CRC-valid manifest with a bad length", async () => {
    const m = encodeGeneration({
      generation: 1,
      through: 0,
      marks: NO_MARKS,
      runs: [{ path: "l1/a.sst", bytes: 100, range: { smallest: utf("a"), largest: utf("b") }, marksThrough: 0, index: NO_BLOCKS }],
    });
    // Run count and the first path length, inflated (found by "manifests ... reject every change").
    // The run count follows the 32-byte header and the 4-byte empty marks block.
    new DataView(m.buffer).setUint32(38, 0xffffffff, true);
    fixManifestCrc(m);
    await expect(corruptWithinBounds("decodeGeneration", () => decodeGeneration(m))).resolves.toBeUndefined();
  });

  // KW1, tab path (`range({ valueContains })`). On wasm32 an offset is 32
  // bits and wraps, so a check written `o + key_len > end` passes for a
  // varint near 2^32 and the read after it is out of bounds. The engine
  // checks `key_len > end - o`, with `o <= end`.
  it("KW1: scan_block_contains does not panic on a varint near 2^32", () => {
    const block = new Uint8Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0xf0, 0xff, 0xff, 0xff, 0x0f, 1, 2, 3]);
    expect(() => scanBlockContainsIn(wasm, block, packPatterns([]))).not.toThrow(WebAssembly.RuntimeError);
  });

  // KW2, SharedWorker with wasm. The module threw the Rust error as a bare
  // string ("CrcMismatch") and the compaction merge passed it on, so a
  // compaction over a corrupt run failed with a string, not
  // CorruptDatabaseError. The engine now wraps it, and the port carries the
  // error's code so the tab rethrows the same class.
  it("KW2: a compaction over a run with a bad CRC throws CorruptDatabaseError", async () => {
    const buf = encodeSstRef(entries);
    buf[5]! ^= 1;
    const input = () => ({ size: buf.byteLength, index: recorded.index });
    await expect(corruptWithinBounds("merge session", () => mergeRuns([[buf]], { input }))).resolves.toBeUndefined();
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
        scanBlockContainsIn(wasm, block, packPatterns([]));
      } catch {
        // KW1 panicked here.
      }
    }
    expect(decodeSst(encodeRunIn(wasm, entries).body)).toHaveLength(entries.length);
  });

  // A trap that is not a panic on input: the instance's memory cannot grow.
  // The engine replaces the instance and asks the new one, so one trap
  // never poisons later calls.
  it("KW3: after a trap the engine replaces the instance and keeps answering", async () => {
    vi.resetModules();
    const engine = await import("../src/store/engine.js");
    await import("../src/testing.js");
    const { engineMemory } = await import("../src/host/metered-host.js");
    const instantiate = WebAssembly.instantiate.bind(WebAssembly);
    let memory: WebAssembly.Memory | undefined;
    const spy = vi.spyOn(WebAssembly, "instantiate").mockImplementation((async (module: WebAssembly.Module, imports?: WebAssembly.Imports) => {
      const instance = await instantiate(module, imports);
      memory = instance.exports.memory as WebAssembly.Memory;
      return instance;
    }) as typeof WebAssembly.instantiate);
    try {
      await engine.ensureEngine();
    } finally {
      spy.mockRestore();
    }
    const block = blocksOf(encodeSstRef([{ kind: "put", key: utf("big"), value: new Uint8Array(3 << 20).fill(7), seq: 1 }]))[0]!;
    // A scan with no hit leaves the block's input region in place, then the memory takes every page wasm32 allows.
    expect(engine.scanBlock(block, packPatterns([utf("absent")]))).toHaveLength(0);
    memory!.grow(65_536 - memory!.buffer.byteLength / 65_536);

    const hits = engine.unpackHits(engine.scanBlock(block, packPatterns([])));
    expect([...hits].map((h) => h.key)).toEqual([utf("big")]);
    expect(engineMemory()).toMatchObject({ wasmPeakBytes: 2 ** 32 });
    expect(engineMemory().wasmBytes).toBeLessThan(2 ** 28);
    expect(decodeSst((await engine.encodeRun(entries)).body)).toHaveLength(entries.length);
    vi.resetModules();
  });
});

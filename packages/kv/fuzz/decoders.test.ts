import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CheckedOp } from "../src/check.js";
import { KIND_RECORD, KIND_SEAL, encodeFrame, encodeOps } from "../src/log/frame.js";
import { encodeGeneration, type GenerationMeta } from "../src/store/generation.js";
import { encodeSst as encodeSstWasm } from "../src/store/engine.js";
import { encodeSst, type SstEntry } from "../src/store/sst.js";
import { applyMutations, entriesArb, mutationsArb, sameBytes } from "./mutate.js";
import {
  checkDecodeSst,
  checkLz4,
  checkManifest,
  checkLogFrames,
  checkRunRead,
  expectedRead,
  fixFrameCrcs,
  fixManifestCrc,
  framedBlocks,
  repairSst,
  tally,
  type ReadProbe,
  type Repair,
} from "./targets.js";
import { loadWasm, withoutWasm } from "./wasm.js";

/**
 * Byte-mutation properties over every decoder of on-disk bytes (docs/research/corruption-hardening-test-suite.md, technique 7).
 * Valid inputs come from the engine's encoders; mutations are bit flips,
 * truncation, extension, inflated length fields and varints, 0x00/0xff
 * runs, and splices of two valid inputs, with the CRCs rewritten half the
 * time so the decoders see the structure behind it. The rules are in
 * `targets.ts`.
 *
 *   KV_FUZZ_RUNS=20000 pnpm exec vitest run fuzz/decoders.test.ts
 *   KV_FUZZ_SEED=<seed> KV_FUZZ_PATH=<path> pnpm exec vitest run fuzz/decoders.test.ts
 */
const env = process.env;
/** Cases per mutation property; the intact-run property, ten times slower per case, runs a tenth. */
const RUNS = Number(env.KV_FUZZ_RUNS ?? 1000);
const params: fc.Parameters<unknown> = {
  numRuns: RUNS,
  ...(env.KV_FUZZ_SEED ? { seed: Number(env.KV_FUZZ_SEED), ...(env.KV_FUZZ_PATH ? { path: env.KV_FUZZ_PATH } : {}) } : {}),
};
const TIMEOUT = 60_000 + RUNS * 200;

const utf = (s: string) => new TextEncoder().encode(s);

beforeAll(async () => {
  await loadWasm();
});
afterAll(() => {
  if (env.KV_FUZZ_REPORT) console.log([...tally].map(([k, n]) => `${k}: ${n}`).join("\n"));
});

type Codec = "raw" | "lz4";
const runArb = fc.record({
  entries: entriesArb,
  codec: fc.constantFrom<Codec>("raw", "lz4"),
  blockTarget: fc.constantFrom(64, 512, 4096),
});

/** A run as the engine writes it: TypeScript raw blocks of any target, or wasm LZ4. */
async function encodeRun(r: { entries: SstEntry[]; codec: Codec; blockTarget: number }): Promise<Uint8Array> {
  return r.codec === "raw" ? encodeSst(r.entries, r.blockTarget) : encodeSstWasm(r.entries, "lz4");
}

/** Probe keys: every key of the run, and a few that it lacks. */
function probeOf(entries: readonly SstEntry[], extra: readonly string[], withRange: boolean): ReadProbe {
  const keys = [...entries.map((e) => e.key), ...extra.map((k) => utf(`t/${k}`))];
  const sorted = [...entries].sort((a, b) => Buffer.compare(a.key, b.key));
  const range = withRange && sorted.length > 0 ? { smallest: sorted[0]!.key, largest: sorted[sorted.length - 1]!.key } : undefined;
  return { keys, range, pattern: utf(" hot") };
}

const repairArb = fc.constantFrom<Repair>("none", "crc", "trailer");

const extraKeys = fc.array(fc.string({ unit: fc.constantFrom(..."ab/0129".split("")), maxLength: 6 }), { maxLength: 4 });

describe("decoder properties (fast-check)", () => {
  it(
    "a tab reads an intact run exactly, with wasm and with the TypeScript fallbacks",
    async () => {
      await expect(
        fc.assert(
          fc.asyncProperty(runArb, extraKeys, async (r, extra) => {
            const buf = await encodeRun(r);
            const probe = probeOf(r.entries, extra, true);
            const want = expectedRead(r.entries, probe);
            expect(await checkRunRead(buf, probe)).toEqual(want);
            expect(await withoutWasm(() => checkRunRead(buf, probe))).toEqual(want);
          }),
          { ...params, numRuns: Math.ceil(RUNS / 10) },
        ),
      ).resolves.toBeUndefined();
    },
    TIMEOUT,
  );

  it(
    "a tab reads any mutation of a run within the rules",
    async () => {
      await expect(
        fc.assert(
          fc.asyncProperty(runArb, runArb, mutationsArb, repairArb, fc.boolean(), extraKeys, async (r, o, ms, repair, wasm, extra) => {
            const buf = applyMutations(await encodeRun(r), ms, await encodeRun(o));
            repairSst(buf, repair);
            const probe = probeOf(r.entries, extra, ms.length % 2 === 0);
            await (wasm ? checkRunRead(buf, probe) : withoutWasm(() => checkRunRead(buf, probe)));
          }),
          params,
        ),
      ).resolves.toBeUndefined();
    },
    TIMEOUT,
  );

  it(
    "the SharedWorker's decode rejects every change under the CRC and survives the rest",
    async () => {
      await expect(
        fc.assert(
          fc.asyncProperty(runArb, runArb, mutationsArb, repairArb, async (r, o, ms, repair) => {
            const orig = await encodeRun(r);
            const other = await encodeRun(o);
            const buf = applyMutations(orig, ms, other);
            repairSst(buf, repair);
            const same = sameBytes(buf, orig);
            // A splice can rebuild the other run whole: valid bytes, not a change.
            const got = await checkDecodeSst(buf, repair === "none" && !same && !sameBytes(buf, other));
            if (same) expect(got?.length).toBe(r.entries.length);
          }),
          params,
        ),
      ).resolves.toBeUndefined();
    },
    TIMEOUT,
  );

  it(
    "manifests, versions 1 to 3, reject every change under the CRC",
    async () => {
      await expect(
        fc.assert(
          fc.asyncProperty(manifestArb, manifestArb, fc.constantFrom(1, 2, 3), mutationsArb, fc.boolean(), async (m, o, version, ms, crc) => {
            const orig = encodeManifestVersion(m, version);
            const other = encodeGeneration(o);
            const buf = applyMutations(orig, ms, other);
            if (crc) fixManifestCrc(buf);
            const same = sameBytes(buf, orig);
            const got = await checkManifest(buf, !crc && !same && !sameBytes(buf, other));
            if (same) expect(got).toEqual(version === 1 ? { ...m, through: 0, cut: 0 } : version === 2 ? { ...m, cut: 0 } : m);
          }),
          params,
        ),
      ).resolves.toBeUndefined();
    },
    TIMEOUT,
  );

  it(
    "a log read returns a prefix of whole frames that encode back to the input, or throws corrupt log",
    async () => {
      await expect(
        fc.assert(
          fc.asyncProperty(logArb, logArb, mutationsArb, fc.boolean(), fc.boolean(), async (log, other, ms, mutate, crc) => {
            const orig = encodeLog(log);
            const buf = mutate ? applyMutations(orig, ms, encodeLog(other)) : orig.slice();
            if (crc) fixFrameCrcs(buf);
            // From the tab's first record, and after reclaimed segments.
            const scan = await checkLogFrames(buf, 0, 0);
            await checkLogFrames(buf, undefined, 0);
            if (sameBytes(buf, orig)) {
              expect(scan?.records.length).toBe(log.records.length);
              expect(scan?.sealed).toBe(log.sealed);
              expect(scan?.validBytes).toBe(orig.byteLength);
            }
          }),
          params,
        ),
      ).resolves.toBeUndefined();
    },
    TIMEOUT,
  );

  it(
    "the TypeScript LZ4 decoder returns exactly size bytes or throws CorruptDatabaseError",
    async () => {
      await expect(
        fc.assert(
          fc.asyncProperty(lz4BlockArb, mutationsArb, fc.integer({ min: -64, max: 64 }), async (b, ms, dsize) => {
            const block = await lz4Block(b);
            const src = applyMutations(block.subarray(4), ms, block);
            const size = new DataView(block.buffer, block.byteOffset).getUint32(0, true);
            await checkLz4(src, Math.max(0, size + (ms.length === 1 ? 0 : dsize)));
          }),
          params,
        ),
      ).resolves.toBeUndefined();
    },
    TIMEOUT,
  );
});

const manifestArb: fc.Arbitrary<GenerationMeta> = fc.record({
  generation: fc.integer({ min: 0, max: 2 ** 40 }),
  tombstoneSeq: fc.integer({ min: 0, max: 2 ** 40 }),
  through: fc.integer({ min: 0, max: 2 ** 40 }),
  cut: fc.integer({ min: 0, max: 2 ** 53 - 1 }),
  runs: fc.array(
    fc.record(
      {
        path: fc.constantFrom("l0/f1.sst", "l1/c7.0-4096.sst", "l2/c9.3-123456.sst"),
        range: fc.record({ smallest: fc.uint8Array({ maxLength: 12 }), largest: fc.uint8Array({ maxLength: 12 }) }),
      },
      { requiredKeys: ["path"] },
    ),
    { maxLength: 6 },
  ),
});

/**
 * A manifest in an older version, which the engine still reads
 * (generation.ts): version 1 has no `through` or `cut`, version 2 no `cut`.
 */
function encodeManifestVersion(m: GenerationMeta, version: number): Uint8Array {
  const v3 = encodeGeneration(m);
  if (version === 3) return v3;
  const from = version === 1 ? 24 : 32;
  const out = new Uint8Array(v3.byteLength - (40 - from));
  out.set(v3.subarray(0, from));
  out.set(v3.subarray(40), from);
  new DataView(out.buffer).setUint32(4, version, true);
  fixManifestCrc(out);
  return out;
}

const opsArb: fc.Arbitrary<CheckedOp[]> = fc.array(
  fc.oneof(
    fc.record({ type: fc.constant("put" as const), key: fc.uint8Array({ maxLength: 16 }), value: fc.uint8Array({ maxLength: 32 }) }),
    fc.record({ type: fc.constant("del" as const), key: fc.uint8Array({ maxLength: 16 }) }),
  ),
  { minLength: 1, maxLength: 6 },
) as fc.Arbitrary<CheckedOp[]>;

/** One log segment from a tab's first record: records with rising stamps, maybe sealed. */
type Log = { records: { gap: number; ops: CheckedOp[] }[]; sealed: boolean };
const logArb: fc.Arbitrary<Log> = fc.record({
  records: fc.array(fc.record({ gap: fc.integer({ min: 1, max: 2 ** 20 }), ops: opsArb }), { maxLength: 6 }),
  sealed: fc.boolean(),
});

function encodeLog(log: Log): Uint8Array {
  const frames: Uint8Array[] = [];
  let stamp = 1_000_000;
  log.records.forEach((r, i) => {
    stamp += r.gap;
    frames.push(encodeFrame(KIND_RECORD, stamp, i + 1, encodeOps(r.ops)));
  });
  if (log.sealed) frames.push(encodeFrame(KIND_SEAL, stamp, log.records.length, new Uint8Array(0)));
  const out = new Uint8Array(frames.reduce((n, f) => n + f.byteLength, 0));
  let o = 0;
  for (const f of frames) {
    out.set(f, o);
    o += f.byteLength;
  }
  return out;
}

/** Entries and which of their LZ4 blocks to take. */
const lz4BlockArb = fc.record({ entries: entriesArb.filter((e) => e.length > 0), pick: fc.nat() });

/** One framed LZ4 block (u32 size, then LZ4 bytes) of a wasm-encoded run. */
async function lz4Block(b: { entries: SstEntry[]; pick: number }): Promise<Uint8Array> {
  const blocks = framedBlocks(await encodeSstWasm(b.entries, "lz4"));
  return blocks[b.pick % blocks.length]!;
}

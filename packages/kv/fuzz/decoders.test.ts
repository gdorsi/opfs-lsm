import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeGeneration, type GenerationMeta } from "../src/store/generation.js";
import { encodeSst as encodeSstWasm } from "../src/store/engine.js";
import { encodeSst, type SstEntry } from "../src/store/sst.js";
import { applyMutations, entriesArb, mutationsArb, sameBytes } from "./mutate.js";
import {
  checkDecodeSst,
  checkLz4,
  checkManifest,
  checkRunRead,
  checkWalRow,
  encodeWalRow,
  expectedRead,
  fixManifestCrc,
  framedBlocks,
  repairSst,
  tally,
  type ReadProbe,
  type Repair,
  type RowOp,
} from "./targets.js";
import { loadWasm, withoutWasm } from "./wasm.js";
import { joinMarks, markTable, NO_MARKS, type Marks } from "../src/store/marks.js";

/**
 * Byte-mutation properties over every decoder of on-disk and IndexedDB
 * bytes (docs/research/corruption-hardening-test-suite.md, technique 7).
 * Valid inputs come from the engine's encoders; mutations are bit flips,
 * truncation, extension, inflated length fields and varints, 0x00/0xff
 * runs, and splices of two valid inputs, with the CRC rewritten half the
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
    "a tab reads an intact run exactly, with the wasm decoders and with the JS ones",
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
    "manifests reject every change under the CRC",
    async () => {
      await expect(
        fc.assert(
          fc.asyncProperty(manifestArb, manifestArb, mutationsArb, fc.boolean(), async (m, o, ms, crc) => {
            const orig = encodeGeneration(m);
            const other = encodeGeneration(o);
            const buf = applyMutations(orig, ms, other);
            if (crc) fixManifestCrc(buf);
            const same = sameBytes(buf, orig);
            const got = await checkManifest(buf, !crc && !same && !sameBytes(buf, other));
            if (same) expect(got).toEqual(m);
          }),
          params,
        ),
      ).resolves.toBeUndefined();
    },
    TIMEOUT,
  );

  it(
    "WAL rows decode to the ops that encode back to them, or throw corrupt wal row",
    async () => {
      await expect(
        fc.assert(
          fc.asyncProperty(walRowArb, walRowArb, mutationsArb, fc.boolean(), async (ops, other, ms, mutate) => {
            const orig = encodeWalRow(ops);
            const buf = mutate ? applyMutations(orig, ms, encodeWalRow(other)) : orig;
            await checkWalRow(buf.slice().buffer);
          }),
          params,
        ),
      ).resolves.toBeUndefined();
      // A row that is not bytes, as a foreign writer could leave it.
      for (const raw of [undefined, null, 7, "row", [1, 2], new Uint8Array(4), {}]) await checkWalRow(raw);
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

/** The marks of a manifest at `through`: range deletes from records at or below it. */
function marksArb(through: number): fc.Arbitrary<Marks> {
  if (through < 2) return fc.constant(NO_MARKS);
  const mark = fc
    .record({ start: fc.uint8Array({ maxLength: 6 }), size: fc.option(fc.uint8Array({ minLength: 1, maxLength: 2 })), t: fc.integer({ min: 1, max: through - 1 }) })
    .chain(({ start, size, t }) =>
      fc.integer({ min: t + 1, max: through }).map((at) => {
        const end = size === null ? undefined : new Uint8Array([...start, ...size]);
        return markTable({ start, ...(end ? { endExclusive: end } : {}), through: t, at });
      }),
    );
  return fc.array(mark, { maxLength: 4 }).map((tables) => tables.reduce(joinMarks, NO_MARKS));
}

const manifestArb: fc.Arbitrary<GenerationMeta> = fc.integer({ min: 0, max: 2 ** 40 }).chain((through) =>
  fc.record({
    generation: fc.integer({ min: 0, max: 2 ** 40 }),
    tombstoneSeq: fc.integer({ min: 0, max: 2 ** 40 }),
    through: fc.constant(through),
    marks: marksArb(through),
    runs: fc.array(
      fc.record(
        {
          path: fc.constantFrom("l0/f1.sst", "l1/c7.0.sst", "l2/c9.3.sst"),
          bytes: fc.integer({ min: 0, max: 2 ** 32 - 1 }),
          range: fc.record({ smallest: fc.uint8Array({ maxLength: 12 }), largest: fc.uint8Array({ maxLength: 12 }) }),
          marksThrough: fc.integer({ min: 0, max: through }),
        },
        { requiredKeys: ["path", "bytes", "marksThrough"] },
      ),
      { maxLength: 6 },
    ),
  }),
);

const walRowArb: fc.Arbitrary<RowOp[]> = fc.array(
  fc.oneof(
    fc.record({ put: fc.uint8Array({ maxLength: 16 }), value: fc.uint8Array({ maxLength: 32 }) }),
    fc.record({ del: fc.uint8Array({ maxLength: 16 }) }),
    fc
      .record({ start: fc.uint8Array({ maxLength: 8 }), size: fc.option(fc.uint8Array({ minLength: 1, maxLength: 4 })), through: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }) })
      .map(({ start, size, through }) => ({ deleteRange: start, ...(size === null ? {} : { end: new Uint8Array([...start, ...size]) }), through })),
  ),
  { minLength: 1, maxLength: 6 },
);

/** Entries and which of their LZ4 blocks to take. */
const lz4BlockArb = fc.record({ entries: entriesArb.filter((e) => e.length > 0), pick: fc.nat() });

/** One framed LZ4 block (u32 size, then LZ4 bytes) of a wasm-encoded run. */
async function lz4Block(b: { entries: SstEntry[]; pick: number }): Promise<Uint8Array> {
  const blocks = framedBlocks(await encodeSstWasm(b.entries, "lz4"));
  return blocks[b.pick % blocks.length]!;
}

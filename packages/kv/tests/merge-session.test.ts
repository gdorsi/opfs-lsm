import { beforeAll, describe, expect, it } from "vitest";
import { compareBytes, keyToString } from "../src/bytes.js";
import { CorruptDatabaseError } from "../src/errors.js";
import { DEFAULT_COMPACTION_MEMORY_BYTES, hostBudget } from "../src/host/budget.js";
import { mergeNextStep, pumpMerge } from "../src/host/compact.js";
import type { AsyncFs, FileWriter, OpenFile } from "../src/opfs/async-fs.js";
import { encodeRunIn, openMergeIn, type MergeCore, type MergeSpec } from "../src/store/engine.js";
import { loadLatestGeneration, publishGeneration, type RunMeta } from "../src/store/generation.js";
import { openMergeTs } from "./oracle/merge-ts.js";
import { decodeSst, encodeRun, entryRecordSize, sstKeyRange, type SstCodec, type SstEntry } from "../src/store/sst.js";
import { fixSstCrc } from "../fuzz/targets.js";
import { loadWasm, type FlatEngine } from "../fuzz/wasm.js";
import { publish } from "./runs.js";
import { MemoryFs } from "../src/testing.js";
import { joinMarks, markTable, NO_MARKS, throughAt, type Marks } from "../src/store/marks.js";

/**
 * The TypeScript merge session against the wasm one, both pumped by the
 * compaction driver over the same runs. Small and odd windows split reads,
 * blocks and runs everywhere. Both must give the newest-wins fold of their
 * inputs, cut into runs at the same keys; their raw runs must be the same
 * bytes.
 *
 *   KV_MERGE_CASES=3000 KV_MERGE_SEED=7 pnpm exec vitest run tests/merge-session.test.ts
 */
const CASES = Number(process.env.KV_MERGE_CASES ?? 150);
const SEED = Number(process.env.KV_MERGE_SEED ?? 1);

const utf = (s: string) => new TextEncoder().encode(s);

let wasm: FlatEngine;
beforeAll(async () => {
  wasm = await loadWasm();
});

type Rng = { below(n: number): number; chance(p: number): boolean; pick<T>(xs: readonly T[]): T };

function rng(seed: number): Rng {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
  return {
    below: (n) => next() % n,
    chance: (p) => next() / 2 ** 32 < p,
    pick: (xs) => xs[next() % xs.length]!,
  };
}

type Source = { readonly runs: readonly Uint8Array[]; readonly entries: readonly SstEntry[] };

/**
 * Entries in key order with duplicates of a key next to each other, cut into
 * runs anywhere, also between two duplicates. Runs are raw or LZ4, and some
 * are empty.
 */
function source(r: Rng, seq: { next: number }): Source {
  const entries: SstEntry[] = [];
  let k = r.below(30);
  const n = r.chance(0.1) ? 0 : 1 + r.below(r.chance(0.2) ? 500 : 40);
  for (let i = 0; i < n; i++) {
    if (i > 0 && !r.chance(0.2)) k += 1 + r.below(3);
    const key = utf(`key/${String(k).padStart(5, "0")}`);
    const size = r.chance(0.01) ? 70_000 : r.chance(0.05) ? 3_000 : r.below(40);
    entries.push(
      r.chance(0.2)
        ? { kind: "del", key, seq: seq.next++ }
        : { kind: "put", key, value: new Uint8Array(size).fill(k & 0xff), seq: seq.next++ },
    );
  }
  const cuts = [...new Set(Array.from({ length: r.below(4) }, () => r.below(n + 1)))].sort((a, b) => a - b);
  const pieces: SstEntry[][] = [];
  let from = 0;
  for (const cut of [...cuts, n]) {
    pieces.push(entries.slice(from, cut));
    from = cut;
  }
  if (r.chance(0.1)) pieces.splice(r.below(pieces.length + 1), 0, []);
  const runs = pieces.map((p) => (r.chance(0.5) ? encodeRun(p).body : encodeRunIn(wasm, p, true).body));
  return { runs, entries };
}

/**
 * Up to three range deletes over the `key/` keys, joined, each through a seq
 * of the case, so some winners are covered and some are just past it.
 */
function randomMarks(r: Rng, seqs: number): Marks {
  let marks = NO_MARKS;
  for (let i = r.below(4); i > 0; i--) {
    const from = r.below(60);
    const through = 1 + r.below(seqs);
    const end = r.chance(0.2) ? undefined : utf(`key/${String(from + 1 + r.below(40)).padStart(5, "0")}${r.chance(0.3) ? "!" : ""}`);
    marks = joinMarks(marks, markTable({ start: utf(`key/${String(from).padStart(5, "0")}`), endExclusive: end, through, at: through + 1 }));
  }
  return marks;
}

/**
 * The newest-wins fold: oldest source first, so newer sources and later
 * duplicates overwrite. A winner a mark covers is gone.
 */
function fold(sources: readonly Source[], drop: boolean, marks: Marks): { entries: SstEntry[]; droppedSeq: number } {
  const byKey = new Map<string, SstEntry>();
  for (let i = sources.length - 1; i >= 0; i--) for (const e of sources[i]!.entries) byKey.set(keyToString(e.key), e);
  let droppedSeq = 0;
  const entries: SstEntry[] = [];
  for (const e of [...byKey.values()].sort((a, b) => compareBytes(a.key, b.key))) {
    if (!marks.empty && e.seq <= throughAt(marks, e.key)) continue;
    if (drop && e.kind === "del") droppedSeq = Math.max(droppedSeq, e.seq ?? 0);
    else entries.push(e);
  }
  return { entries, droppedSeq };
}

/** `entries` cut where a run's `entryRecordSize`s reach `target`, as a merge cuts them. */
function cut(entries: readonly SstEntry[], target: number): SstEntry[][] {
  const runs: SstEntry[][] = [];
  let run: SstEntry[] = [];
  let size = 0;
  for (const e of entries) {
    run.push(e);
    size += entryRecordSize(e);
    if (size >= target) {
      runs.push(run);
      run = [];
      size = 0;
    }
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

const plain = (entries: readonly SstEntry[]) =>
  entries.map((e) => `${e.kind} ${keyToString(e.key)} ${e.seq} ${e.kind === "put" ? keyToString(e.value) : ""}`);

const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(b);

type Merged = { runs: { meta: RunMeta; body: Uint8Array }[]; droppedSeq: number };

/** Pump a session opened by `open` over the runs at `paths`, writing to `out/<label>.<i>.sst`. */
async function merge(
  fs: MemoryFs,
  open: (spec: MergeSpec) => MergeCore,
  spec: MergeSpec,
  paths: readonly (readonly string[])[],
  label: string,
  wrapFs: (fs: AsyncFs) => AsyncFs = (f) => f,
  wrapFile: (file: OpenFile) => OpenFile = (f) => f,
): Promise<Merged> {
  const inputs = await Promise.all(paths.map((runs) => Promise.all(runs.map(async (p) => wrapFile((await fs.open(p))!)))));
  const core = open(spec);
  try {
    const { outputs, droppedSeq } = await pumpMerge(wrapFs(fs), core, inputs, (i) => `out/${label}.${i}.sst`);
    const runs = await Promise.all(outputs.map(async (meta) => ({ meta, body: (await fs.read(meta.path, 0, Infinity))! })));
    return { runs, droppedSeq };
  } finally {
    core.close();
    for (const file of inputs.flat()) file.close();
  }
}

const openWasm = (spec: MergeSpec): MergeCore => openMergeIn(wasm, spec);

type Case = { fs: MemoryFs; sources: Source[]; paths: string[][]; spec: MergeSpec };

async function makeCase(r: Rng): Promise<Case> {
  const fs = new MemoryFs();
  const seq = { next: 1 };
  // Oldest first, so newer sources hold higher seqs, as in a database.
  const sources = Array.from({ length: 1 + r.below(5) }, () => source(r, seq)).reverse();
  const paths = sources.map((s, i) => s.runs.map((_, j) => `in/${i}.${j}.sst`));
  for (const [i, s] of sources.entries()) for (const [j, run] of s.runs.entries()) await publish(fs, paths[i]![j]!, run);
  const spec: MergeSpec = {
    sources: sources.map((s) => s.runs.map((run) => run.byteLength)),
    dropTombstones: r.chance(0.5),
    targetBytes: r.pick([1, 40, 120, 1000, 64 * 1024, Number.MAX_SAFE_INTEGER]),
    codec: r.pick<SstCodec>(["raw", "lz4"]),
    chunkBytes: r.pick([1, 37, 512, 4096, 64 * 1024]),
    tailBytes: r.pick([0, 44, 45, 100, 1000, 4096, 128 * 1024]),
    yieldBytes: r.pick([1, 1000, Number.MAX_SAFE_INTEGER]),
    marks: r.chance(0.5) ? NO_MARKS : randomMarks(r, seq.next),
  };
  return { fs, sources, paths, spec };
}

describe("the TypeScript and wasm merge sessions, through the compaction driver", () => {
  it(
    "merge the same runs to the newest-wins fold, cut at the same keys, raw runs the same bytes",
    async () => {
      const r = rng(SEED);
      for (let c = 0; c < CASES; c++) {
        const { fs, sources, paths, spec } = await makeCase(r);
        const expected = fold(sources, spec.dropTombstones, spec.marks);
        const ts = await merge(fs, openMergeTs, spec, paths, "ts");
        const w = await merge(fs, openWasm, spec, paths, "wasm");
        for (const out of [ts, w]) {
          expect(out.droppedSeq).toBe(expected.droppedSeq);
          expect(out.runs.map((run) => plain(decodeSst(run.body)))).toEqual(cut(expected.entries, spec.targetBytes).map(plain));
          for (const run of out.runs) {
            expect(run.meta.bytes).toBe(run.body.byteLength);
            expect(run.meta.range).toEqual(sstKeyRange(run.body));
          }
        }
        if (spec.codec === "raw") {
          expect(w.runs.length).toBe(ts.runs.length);
          for (const [i, run] of w.runs.entries()) expect(same(run.body, ts.runs[i]!.body)).toBe(true);
        }
      }
    },
    120_000,
  );

  it(
    "never finish over a run with a flipped byte",
    async () => {
      const r = rng(SEED + 1);
      let flipped = 0;
      for (let c = 0; c < CASES; c++) {
        const { fs, paths, spec } = await makeCase(r);
        const runs = paths.flat();
        const path = r.pick(runs);
        const bytes = (await fs.read(path, 0, Infinity))!;
        bytes[r.below(bytes.byteLength)]! ^= 1 + r.below(255);
        await publish(fs, path, bytes);
        flipped++;
        for (const [label, open] of [["ts", openMergeTs], ["wasm", openWasm]] as const) {
          await expect(merge(fs, open, spec, paths, label)).rejects.toThrow(CorruptDatabaseError);
        }
        expect(fs.publishedPaths().filter((p) => p.startsWith("out/"))).toEqual([]);
      }
      expect(flipped).toBe(CASES);
    },
    120_000,
  );
});

describe("what a CRC cannot catch, both sessions refuse", () => {
  const puts = (...keys: string[]): SstEntry[] => keys.map((k, i) => ({ kind: "put", key: utf(k), value: utf("v"), seq: i + 1 }));
  const footer = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset + b.byteLength - 44, 44);

  /** What each session ends with over one source of `runs`: the error it threw, or "done". */
  async function ends(runs: Uint8Array[]): Promise<unknown[]> {
    const fs = new MemoryFs();
    const paths = [runs.map((_, j) => `in/0.${j}.sst`)];
    for (const [j, run] of runs.entries()) await publish(fs, paths[0]![j]!, run);
    const spec: MergeSpec = {
      sources: [runs.map((run) => run.byteLength)],
      dropTombstones: false,
      marks: NO_MARKS,
      targetBytes: Number.MAX_SAFE_INTEGER,
      codec: "raw",
      chunkBytes: 64,
      tailBytes: 64,
      yieldBytes: Number.MAX_SAFE_INTEGER,
    };
    const out: unknown[] = [];
    for (const [label, open] of [["ts", openMergeTs], ["wasm", openWasm]] as const) {
      out.push(await merge(fs, open, spec, paths, label).then(() => "done", (err: unknown) => err));
    }
    return out;
  }
  const bothRefuse = [expect.any(CorruptDatabaseError), expect.any(CorruptDatabaseError)];

  /** A run with no data blocks, which no encoder writes (an empty run gets one empty block): bloom bits, no index, a footer. */
  function blockless(): Uint8Array {
    const bloom = 8;
    const run = new Uint8Array(bloom + 44);
    const f = footer(run);
    [0, 0, 0, bloom, 7, bloom, 0, 0].forEach((v, i) => f.setUint32(4 * i, v, true));
    f.setUint32(36, 1, true);
    f.setUint32(40, 0x4f4c5354, true);
    fixSstCrc(run);
    return run;
  }

  it("every single flipped byte of a run, empty or not, whatever part of it the tail holds", async () => {
    const fs = new MemoryFs();
    await publish(fs, "in/blockless.sst", blockless());
    const intact = (tailBytes: number): MergeSpec => ({
      sources: [[blockless().byteLength]],
      dropTombstones: false,
      marks: NO_MARKS,
      targetBytes: Number.MAX_SAFE_INTEGER,
      codec: "raw",
      chunkBytes: 16,
      tailBytes,
      yieldBytes: Number.MAX_SAFE_INTEGER,
    });
    for (const [label, open] of [["ts", openMergeTs], ["wasm", openWasm]] as const) {
      for (const tailBytes of [44, 60]) expect((await merge(fs, open, intact(tailBytes), [["in/blockless.sst"]], label)).runs).toEqual([]);
    }

    const runs = [blockless(), encodeRun([]).body, encodeRun(puts("a", "b", "c")).body, encodeRunIn(wasm, puts("a", "b", "c"), true).body];
    for (const run of runs) {
      for (let at = 0; at < run.byteLength; at++) {
        const bad = run.slice();
        bad[at]! ^= 0x10;
        const fs = new MemoryFs();
        await publish(fs, "in/0.0.sst", bad);
        for (const tailBytes of [44, 45, run.byteLength - 1, run.byteLength]) {
          const spec: MergeSpec = {
            sources: [[bad.byteLength]],
            dropTombstones: false,
            marks: NO_MARKS,
            targetBytes: Number.MAX_SAFE_INTEGER,
            codec: "raw",
            chunkBytes: 16,
            tailBytes,
            yieldBytes: Number.MAX_SAFE_INTEGER,
          };
          for (const [label, open] of [["ts", openMergeTs], ["wasm", openWasm]] as const) {
            await expect(merge(fs, open, spec, [["in/0.0.sst"]], label)).rejects.toThrow(CorruptDatabaseError);
          }
        }
      }
    }
  });

  it("a source whose keys go back from one run to the next", async () => {
    expect(await ends([encodeRun(puts("b", "d")).body, encodeRun(puts("c", "e")).body])).toEqual(bothRefuse);
  });

  it("a footer that miscounts its entries", async () => {
    const run = encodeRun(puts("a", "b", "c")).body;
    footer(run).setUint32(0, 4, true);
    fixSstCrc(run);
    expect(await ends([run])).toEqual(bothRefuse);
  });

  it("an index whose blocks do not tile the data", async () => {
    const run = encodeRun(puts(...Array.from({ length: 400 }, (_, i) => `key/${String(i).padStart(4, "0")}`))).body;
    // The first index row's offset: past its two key lengths and keys.
    const f = footer(run);
    const index = new DataView(run.buffer, run.byteOffset + f.getUint32(20, true));
    const first = index.getUint32(0, true);
    const last = index.getUint32(4 + first, true);
    index.setUint32(8 + first + last, 1, true);
    fixSstCrc(run);
    expect(await ends([run])).toEqual(bothRefuse);
  });
});

describe("a session's protocol, in both sessions", () => {
  it("takes a feed only for a listed demand of its length, and refuses a pump before every demand is fed", async () => {
    const a = encodeRun([{ kind: "put", key: utf("a"), value: utf("1"), seq: 1 }]).body;
    const b = encodeRun([{ kind: "put", key: utf("b"), value: utf("2"), seq: 2 }]).body;
    const spec: MergeSpec = {
      sources: [[a.byteLength], [b.byteLength]],
      dropTombstones: false,
      marks: NO_MARKS,
      targetBytes: Number.MAX_SAFE_INTEGER,
      codec: "raw",
      chunkBytes: 1024,
      tailBytes: 1024,
      yieldBytes: Number.MAX_SAFE_INTEGER,
    };
    for (const open of [openMergeTs, openWasm]) {
      const core = open(spec);
      try {
        const stop = core.pump();
        if (stop.kind !== "need") throw new Error(`expected need, got ${stop.kind}`);
        expect(stop.demands.map((d) => [d.source, d.run, d.offset, d.length])).toEqual([
          [0, 0, 0, a.byteLength],
          [1, 0, 0, b.byteLength],
        ]);
        expect(() => core.feed(0, a.subarray(1))).toThrow(/no unfed demand/);
        expect(() => core.feed(2, a)).toThrow(/no unfed demand/);
        core.feed(0, a);
        expect(() => core.feed(0, a)).toThrow(/no unfed demand/);
        // A host bug, not corrupt data, and the session goes on once it is fed.
        expect(() => core.pump()).toThrow(/a demand was not fed/);
        expect(() => core.pump()).not.toThrow(CorruptDatabaseError);
        core.feed(1, b);
        const stops: string[] = [];
        for (let s = core.pump(); s.kind !== "done"; s = core.pump()) stops.push(s.kind);
        expect(stops).toEqual(["write", "run-end"]);
      } finally {
        core.close();
        core.close();
      }
    }
  });

  it("keeps a closed wasm handle away from the session opened after it", () => {
    const a = encodeRun([{ kind: "put", key: utf("a"), value: utf("1"), seq: 1 }]).body;
    const spec: MergeSpec = {
      sources: [[a.byteLength]],
      dropTombstones: false,
      marks: NO_MARKS,
      targetBytes: Number.MAX_SAFE_INTEGER,
      codec: "raw",
      chunkBytes: 1024,
      tailBytes: 1024,
      yieldBytes: Number.MAX_SAFE_INTEGER,
    };
    const first = openWasm(spec);
    first.close();
    const second = openWasm(spec);
    try {
      first.close();
      expect(() => first.pump()).toThrow(/merge session closed/);
      expect(() => first.feed(0, a)).toThrow(/merge session closed/);
      // The module's one session is still the second handle's.
      expect(second.pump().kind).toBe("need");
      second.feed(0, a);
      const stops: string[] = [];
      for (let s = second.pump(); s.kind !== "done"; s = second.pump()) stops.push(s.kind);
      expect(stops).toEqual(["write", "run-end"]);
    } finally {
      second.close();
    }
  });
});

describe("the compaction driver", () => {
  /** Fails the `at`-th read, create, write or finish. */
  class Faults {
    private n = 0;
    readonly seen: string[] = [];
    constructor(private readonly at: number) {}
    tick(what: string): void {
      this.seen.push(what);
      if (++this.n === this.at) throw new Error(`injected: ${what}`);
    }
  }

  it("removes every output it wrote when a read, create, write or finish fails", async () => {
    const r = rng(SEED + 2);
    const seq = { next: 1 };
    const sources = [source(r, seq), source(r, seq), source(r, seq)];
    const fs = new MemoryFs();
    const paths = sources.map((s, i) => s.runs.map((_, j) => `in/${i}.${j}.sst`));
    for (const [i, s] of sources.entries()) for (const [j, run] of s.runs.entries()) await publish(fs, paths[i]![j]!, run);
    const spec: MergeSpec = {
      sources: sources.map((s) => s.runs.map((run) => run.byteLength)),
      dropTombstones: false,
      marks: NO_MARKS,
      targetBytes: 200,
      codec: "lz4",
      chunkBytes: 300,
      tailBytes: 100,
      yieldBytes: 1000,
    };
    for (const [label, open] of [["ts", openMergeTs], ["wasm", openWasm]] as const) {
      const kinds = new Set<string>();
      for (let at = 1; ; at++) {
        const faults = new Faults(at);
        const wrapFs = (inner: AsyncFs): AsyncFs => ({
          read: (...a) => inner.read(...a),
          open: (p) => inner.open(p),
          list: (d) => inner.list(d),
          remove: (p) => inner.remove(p),
          removeUnlessOpen: (p) => inner.removeUnlessOpen(p),
          create: async (path): Promise<FileWriter> => {
            faults.tick("create");
            const w = await inner.create(path);
            return {
              write: async (b) => (faults.tick("write"), w.write(b)),
              finish: async () => (faults.tick("finish"), w.finish()),
              abort: () => w.abort(),
            };
          },
        });
        const wrapFile = (file: OpenFile): OpenFile => ({
          size: file.size,
          read: async (o, l) => (faults.tick("read"), file.read(o, l)),
          close: () => file.close(),
        });
        const done = await merge(fs, open, spec, paths, label, wrapFs, wrapFile).then(
          () => true,
          (err: Error) => {
            expect(err.message).toMatch(/^injected/);
            return false;
          },
        );
        if (done) {
          expect(faults.seen.length).toBeLessThan(at);
          break;
        }
        kinds.add(faults.seen[at - 1]!);
        const left = fs.publishedPaths().filter((p) => p.startsWith("out/"));
        expect(left).toEqual([]);
        // Every writer was finished or aborted: a path left staging could not be created again.
        for (let i = 0; i < 20; i++) await (await fs.create(`out/${label}.${i}.sst`)).abort();
      }
      expect([...kinds].sort()).toEqual(["create", "finish", "read", "write"]);
      for (const p of fs.publishedPaths().filter((p) => p.startsWith("out/"))) await fs.remove(p);
    }
  });
});

describe("a compaction step at full size", () => {
  const ROWS = 20_000;
  const put = (i: number, run: number, seq: number): SstEntry => ({
    kind: "put",
    key: utf(`todo/${String(i).padStart(7, "0")}`),
    value: utf(`{"title":"buy milk ${i % 13}","run":${run}}`),
    seq,
  });

  /** Five overlapping L0 runs over one L1 run, about 7 MB in all: two output runs, many reads and writes. */
  async function database(fs: AsyncFs): Promise<SstEntry[][]> {
    const sources: SstEntry[][] = [];
    let seq = 1;
    const l1 = Array.from({ length: ROWS }, (_, i) => put(i * 3, 9, seq++));
    for (let run = 0; run < 5; run++) {
      sources.unshift(
        Array.from({ length: ROWS }, (_, i): SstEntry => {
          const k = i * 5 + run * 7;
          return i % 17 === 0 ? { kind: "del", key: utf(`todo/${String(k).padStart(7, "0")}`), seq: seq++ } : put(k, run, seq++);
        }),
      );
    }
    const metas: RunMeta[] = [];
    for (const [i, entries] of sources.entries()) {
      const { body, end } = encodeRun(entries);
      await publish(fs, `l0/${10 - i}.sst`, body);
      metas.push({ path: `l0/${10 - i}.sst`, ...end, marksThrough: 0 });
    }
    const { body, end } = encodeRun(l1);
    await publish(fs, "l1/c1.0.sst", body);
    metas.push({ path: "l1/c1.0.sst", ...end, marksThrough: 0 });
    await publishGeneration(fs, { generation: 1, runs: metas, tombstoneSeq: 0, through: 0, marks: NO_MARKS });
    return [...sources, l1];
  }

  it(
    "streams windows of each input and writes each run in several writes",
    async () => {
      const reads: number[] = [];
      const writes = new Map<string, number>();
      const base = new MemoryFs();
      const watched: AsyncFs = {
        read: (...a) => base.read(...a),
        list: (d) => base.list(d),
        remove: (p) => base.remove(p),
        removeUnlessOpen: (p) => base.removeUnlessOpen(p),
        open: async (path) => {
          const file = await base.open(path);
          return file && { size: file.size, read: (o, l) => (reads.push(l), file.read(o, l)), close: () => file.close() };
        },
        create: async (path) => {
          const w = await base.create(path);
          return { ...w, write: (b) => (writes.set(path, (writes.get(path) ?? 0) + 1), w.write(b)) };
        },
      };
      const sources = await database(watched);
      const budget = hostBudget(DEFAULT_COMPACTION_MEMORY_BYTES);
      const step = (await mergeNextStep(watched, budget, (await loadLatestGeneration(watched))!, 0))!;

      const sizes = await Promise.all(step.inputs.map(async (p) => (await base.read(p, 0, Infinity))!.byteLength));
      const inputBytes = sizes.reduce((a, b) => a + b, 0);
      expect(step.inputs).toHaveLength(6);
      expect(step.outputs.length).toBeGreaterThanOrEqual(2);
      expect(Math.max(...reads)).toBeLessThanOrEqual(budget.chunkBytes);
      expect(reads.reduce((a, b) => a + b)).toBeGreaterThanOrEqual(inputBytes);
      expect(writes.get(step.outputs[0]!.path)).toBeGreaterThanOrEqual(8);

      const expected = fold(sources.map((entries) => ({ runs: [], entries })), true, NO_MARKS);
      const bodies = await Promise.all(step.outputs.map(async (o) => (await base.read(o.path, 0, Infinity))!));
      expect(plain(bodies.flatMap((b) => decodeSst(b)))).toEqual(plain(expected.entries));
      expect(step.droppedSeq).toBe(expected.droppedSeq);
    },
    60_000,
  );
});

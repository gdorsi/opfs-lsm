/**
 * The wasm memory of a flush, of a merge session, and of both overlapped, each
 * on a fresh instance. These are the measurements behind `hostBudget`
 * (docs/research/bounded-compaction-memory.md, "Memory budget arithmetic").
 *
 *   pnpm --filter @opfs-lsm/kv probe:wasm-memory [flush|merge|overlap]
 *
 * Entries have 16-byte keys and 100-byte values. A figure is the instance's
 * `memory.buffer.byteLength` in MiB, module included.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { encodeRunIn, flatEngine, openMergeIn, type FlatEngine } from "../src/store/engine.js";
import { NO_MARKS } from "../src/store/marks.js";
import type { EncodedRun, SstEntry } from "../src/store/sst.js";

const KiB = 1024;
const MiB = 1024 * KiB;
const POOL = 400_000;
const OP_BYTES = 116;

/** A step of `sources - 1` L0 runs of `flushMiB` and one L1 source of ten 4 MiB runs. */
export type Shape = { sources: number; flushMiB: number; chunk: number; tail: number };

/**
 * The probes over the engine module `wasm`. One set draws one stream of
 * entries, so two modules probed in the same order see the same bytes.
 */
export function memoryProbes(wasm: BufferSource) {
  async function fresh(): Promise<{ engine: FlatEngine; bytes: () => number }> {
    const { instance } = await WebAssembly.instantiate(wasm, {});
    const { memory } = instance.exports as { memory: WebAssembly.Memory };
    return { engine: flatEngine(instance), bytes: () => memory.buffer.byteLength };
  }

  let state = 12345;
  function random(): number {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  }

  const keyOf = (id: number) => new TextEncoder().encode(String(id).padStart(16, "0"));

  function entry(id: number, seq: number): SstEntry {
    const value = new Uint8Array(100);
    for (let i = 0; i < value.length; i += 4) new DataView(value.buffer).setUint32(i, random(), true);
    return { kind: "put", key: keyOf(id), value, seq };
  }

  /** About `opBytes` of entries with distinct random keys, sorted. */
  function sortedEntries(opBytes: number, seq: number): SstEntry[] {
    const ids = new Set<number>();
    while (ids.size < Math.floor(opBytes / OP_BYTES)) ids.add(random() % POOL);
    return [...ids].sort((a, b) => a - b).map((id, i) => entry(id, seq + i));
  }

  /** The memory after three flushes of `flushMiB` of entries, on a fresh instance. */
  async function flush(flushMiB: number): Promise<number> {
    const { engine, bytes } = await fresh();
    const entries = sortedEntries(flushMiB * MiB, 1);
    for (let i = 0; i < 3; i++) encodeRunIn(engine, entries);
    return bytes();
  }

  /** A merge of `shape` on a fresh instance. With `flushEvery`, runs a flush at every that-many-th `need`. */
  async function merge({ sources, flushMiB, chunk, tail }: Shape, flushEvery?: number): Promise<{ open: number; peak: number }> {
    const { engine, bytes } = await fresh();
    const maker = await fresh();
    const files: EncodedRun[][] = [];
    let seq = 1;
    for (let i = 0; i < sources - 1; i++) {
      const entries = sortedEntries(flushMiB * MiB, seq);
      seq += entries.length;
      files.push([encodeRunIn(maker.engine, entries)]);
    }
    const perRun = Math.floor((4 * MiB) / 133);
    const ids = [...new Set(Array.from({ length: 10 * perRun }, () => random() % POOL))].sort((a, b) => a - b);
    const l1: EncodedRun[] = [];
    for (let at = 0; at < ids.length; at += perRun) {
      l1.push(encodeRunIn(maker.engine, ids.slice(at, at + perRun).map((id, i) => entry(id, 1 + i))));
    }
    files.push(l1);
    const core = openMergeIn(engine, {
      sources: files.map((runs) => runs.map((run) => ({ size: run.body.byteLength, index: run.end.index }))),
      dropTombstones: false,
      marks: NO_MARKS,
      targetBytes: 4 * MiB,
      chunkBytes: chunk,
      tailBytes: tail,
      yieldBytes: MiB,
    });
    const open = bytes();
    let peak = open;
    const flushEntries = flushEvery ? sortedEntries(flushMiB * MiB, seq) : [];
    let needs = 0;
    for (;;) {
      const stop = core.pump();
      peak = Math.max(peak, bytes());
      if (stop.kind === "done") break;
      if (stop.kind !== "need") continue;
      if (flushEvery && ++needs % flushEvery === 0) {
        encodeRunIn(engine, flushEntries);
        peak = Math.max(peak, bytes());
      }
      for (const d of stop.demands) core.feed(d.source, files[d.source]![d.run]!.body.slice(d.offset, d.offset + d.length));
      peak = Math.max(peak, bytes());
    }
    core.close();
    return { open, peak };
  }

  return { flush, merge };
}

const mib = (bytes: number) => (bytes / MiB).toFixed(2);

async function main(which: string | undefined): Promise<void> {
  const probes = memoryProbes(await readFile(fileURLToPath(new URL("../wasm/engine.wasm", import.meta.url))));
  if (!which || which === "flush") {
    console.log("flush alone: wasm MiB after three flushes of F op bytes");
    console.log("F MiB | wasm MiB");
    for (const f of [0.875, 1, 1.75, 2, 3.5, 4]) console.log(`${f.toFixed(3)} | ${mib(await probes.flush(f))}`);
  }
  if (!which || which === "merge") {
    console.log("merge alone: S = 49 sources, wasm MiB");
    console.log("C KiB | tail KiB | after open | peak");
    for (const [chunk, tail] of [[64, 64], [64, 128], [128, 128], [256, 128]] as const) {
      const { open, peak } = await probes.merge({ sources: 49, flushMiB: 1.75, chunk: chunk * KiB, tail: tail * KiB });
      console.log(`${chunk} | ${tail} | ${mib(open)} | ${mib(peak)}`);
    }
  }
  if (!which || which === "overlap") {
    console.log("merge with a flush at every seventh need, wasm MiB");
    console.log("S | C KiB | F MiB | peak");
    const rows: Shape[] = [
      { sources: 44, flushMiB: 0.875, chunk: 64 * KiB, tail: 64 * KiB },
      { sources: 49, flushMiB: 1.75, chunk: 128 * KiB, tail: 128 * KiB },
      { sources: 49, flushMiB: 3.5, chunk: 256 * KiB, tail: 128 * KiB },
      { sources: 49, flushMiB: 1.75, chunk: 256 * KiB, tail: 128 * KiB },
    ];
    for (const shape of rows) {
      const { peak } = await probes.merge(shape, 7);
      console.log(`${shape.sources} | ${shape.chunk / KiB} | ${shape.flushMiB} | ${mib(peak)}`);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv[2]);

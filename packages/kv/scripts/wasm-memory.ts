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
import { flatEngine, type FlatEngine } from "../src/store/engine.js";
import type { SstEntry } from "../src/store/sst.js";

const KiB = 1024;
const MiB = 1024 * KiB;
const POOL = 400_000;
const OP_BYTES = 116;
const wasm = await readFile(fileURLToPath(new URL("../wasm/engine.wasm", import.meta.url)));

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

const mib = (bytes: number) => (bytes / MiB).toFixed(2);

async function flush(): Promise<void> {
  console.log("flush alone: wasm MiB after three flushes of F op bytes");
  console.log("F MiB | wasm MiB");
  for (const f of [0.875, 1, 1.75, 2, 3.5, 4]) {
    const { engine, bytes } = await fresh();
    const entries = sortedEntries(f * MiB, 1);
    for (let i = 0; i < 3; i++) engine.encodeRun(entries, false);
    console.log(`${f.toFixed(3)} | ${mib(bytes())}`);
  }
}

type Shape = { sources: number; flushMiB: number; chunk: number; tail: number };

/** A step of `sources - 1` L0 runs of `flushMiB` and one L1 source of ten 4 MiB runs. With `flushEvery`, runs a flush at every that-many-th `need`. */
async function merge({ sources, flushMiB, chunk, tail }: Shape, flushEvery?: number): Promise<{ open: number; peak: number }> {
  const { engine, bytes } = await fresh();
  const maker = await fresh();
  const files: Uint8Array[][] = [];
  let seq = 1;
  for (let i = 0; i < sources - 1; i++) {
    const entries = sortedEntries(flushMiB * MiB, seq);
    seq += entries.length;
    files.push([maker.engine.encodeRun(entries, false).body.slice()]);
  }
  const perRun = Math.floor((4 * MiB) / 133);
  const ids = [...new Set(Array.from({ length: 10 * perRun }, () => random() % POOL))].sort((a, b) => a - b);
  const l1: Uint8Array[] = [];
  for (let at = 0; at < ids.length; at += perRun) {
    const slice = ids.slice(at, at + perRun).map((id, i) => entry(id, 1 + i));
    l1.push(maker.engine.encodeRun(slice, false).body.slice());
  }
  files.push(l1);
  const core = engine.openMerge({
    sources: files.map((runs) => runs.map((run) => run.byteLength)),
    dropTombstones: false,
    targetBytes: 4 * MiB,
    codec: "raw",
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
      engine.encodeRun(flushEntries, false);
      peak = Math.max(peak, bytes());
    }
    for (const d of stop.demands) core.feed(d.source, files[d.source]![d.run]!.slice(d.offset, d.offset + d.length));
    peak = Math.max(peak, bytes());
  }
  core.close();
  return { open, peak };
}

async function mergeAlone(): Promise<void> {
  console.log("merge alone: S = 49 sources, wasm MiB");
  console.log("C KiB | tail KiB | after open | peak");
  for (const [chunk, tail] of [[64, 64], [64, 128], [128, 128], [256, 128]] as const) {
    const { open, peak } = await merge({ sources: 49, flushMiB: 1.75, chunk: chunk * KiB, tail: tail * KiB });
    console.log(`${chunk} | ${tail} | ${mib(open)} | ${mib(peak)}`);
  }
}

async function overlap(): Promise<void> {
  console.log("merge with a flush at every seventh need, wasm MiB");
  console.log("S | C KiB | F MiB | peak");
  const rows: Shape[] = [
    { sources: 44, flushMiB: 0.875, chunk: 64 * KiB, tail: 64 * KiB },
    { sources: 49, flushMiB: 1.75, chunk: 128 * KiB, tail: 128 * KiB },
    { sources: 49, flushMiB: 3.5, chunk: 256 * KiB, tail: 128 * KiB },
    { sources: 49, flushMiB: 1.75, chunk: 256 * KiB, tail: 128 * KiB },
  ];
  for (const shape of rows) {
    const { peak } = await merge(shape, 7);
    console.log(`${shape.sources} | ${shape.chunk / KiB} | ${shape.flushMiB} | ${mib(peak)}`);
  }
}

const which = process.argv[2];
if (!which || which === "flush") await flush();
if (!which || which === "merge") await mergeAlone();
if (!which || which === "overlap") await overlap();

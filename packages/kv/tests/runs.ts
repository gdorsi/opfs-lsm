import { pumpMerge } from "../src/host/compact.js";
import { MemoryFs } from "../src/opfs/memory-fs.js";
import type { AsyncFs } from "../src/opfs/async-fs.js";
import type { Entry } from "../src/index.js";
import { entryOf, Miss, untilHit, valueOf, type LayerCursor, type LayerEntry, type Maybe } from "../src/store/cursor.js";
import { openMerge, type MergeCore, type MergeInput, type MergeSpec } from "../src/store/engine.js";
import { NO_MARKS } from "../src/store/marks.js";
import type { ScanStep } from "../src/store/read.js";
import { PageCache } from "../src/store/page-cache.js";
import type { EncodedRun, RecordWalker, SstEntry } from "../src/store/sst.js";
import { indexBlob, sstRunEnd } from "./oracle/sst-ref.js";
import { bytesFile, SstReader } from "../src/store/sst-reader.js";

export { bytesFile };

/** What a cache holds now: resident bytes, the Bloom filters among them, and the loads in flight. */
export function cacheUsage(cache: PageCache) {
  return { budget: cache.budget, resident: cache["resident"], metadata: cache["queueBytes"].meta, inFlight: cache["loading"].size };
}

/** The index of a manifest entry whose file no test reads: no blocks. */
export const NO_BLOCKS = indexBlob({ sepBytes: new Uint8Array(0), sepEnd: new Uint32Array(0), blockStart: new Uint32Array(1) });

/** A run held in memory as a merge takes it: its size, and the index its manifest entry would record. */
export function mergeInput(run: Uint8Array): MergeInput {
  return { size: run.byteLength, index: sstRunEnd(run).index };
}

/** Resolves once `cache` has no load in flight. A get starts its run's Bloom filter load and does not wait for it. */
export async function loadsDone(cache: PageCache): Promise<void> {
  while (cacheUsage(cache).inFlight) await new Promise((resolve) => setTimeout(resolve));
}

/** A lazy reader over a run held in memory, with the range and the index its manifest entry would record. */
export function readerOfBytes(buf: Uint8Array, cache = new PageCache()): SstReader {
  return new SstReader(bytesFile(buf), cache, sstRunEnd(buf));
}

/** What a run's `get` found, as an entry that owns its value. A Miss passes through. */
export function ownedEntry(at: Maybe<RecordWalker | undefined>, key: Uint8Array): Maybe<SstEntry | undefined> {
  if (at === undefined || at instanceof Miss) return at;
  return at.isPut() ? { kind: "put", key, value: at.valueInPlace().slice(), seq: at.seq() } : { kind: "del", key, seq: at.seq() };
}

/** `reader.get(key)` once its bytes are loaded, as `ownedEntry` gives it. */
export function runGet(reader: Pick<SstReader, "get">, key: Uint8Array): Promise<SstEntry | undefined> {
  return untilHit(() => ownedEntry(reader.get(key), key));
}

/** `e` with its value as an array of its own, wherever its cursor left it. */
function withValue(e: LayerEntry): LayerEntry {
  return e.kind === "put" ? { key: e.key, kind: e.kind, value: valueOf(e), seq: e.seq } : { key: e.key, kind: e.kind, seq: e.seq };
}

/** Every entry left in `cursor`, waiting out its misses. */
export async function drain(cursor: LayerCursor): Promise<LayerEntry[]> {
  const out: LayerEntry[] = [];
  for (;;) {
    const e = await untilHit(() => cursor.peek());
    if (!e) return out;
    out.push(withValue(e));
    cursor.next();
  }
}

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

/** The entries `step` has left, at most `limit`, as a range hands them out. */
export async function entries(step: ScanStep, limit = Infinity): Promise<Entry[]> {
  const out: Entry[] = [];
  while (out.length < limit) {
    const e = await untilHit(step);
    if (!e) break;
    out.push(entryOf(e));
  }
  return out;
}

/** Write `body` to `path` as one published file. */
export async function publish(fs: AsyncFs, path: string, body: Uint8Array): Promise<void> {
  const w = await fs.create(path);
  await w.write(body);
  await w.finish();
}

/**
 * Merge runs held in memory as a compaction step merges them: through the
 * driver (`pumpMerge`) and, unless `open` says otherwise, the session
 * `openMerge` picks. `sources` are newest first, each runs read back to back.
 * A run goes in with the index its bytes give, unless `input` says otherwise.
 */
export async function mergeRuns(
  sources: readonly (readonly Uint8Array[])[],
  options: {
    readonly dropTombstones?: boolean;
    readonly targetBytes?: number;
    readonly open?: (spec: MergeSpec) => MergeCore | Promise<MergeCore>;
    readonly input?: (run: Uint8Array) => MergeInput;
  } = {},
): Promise<{ runs: EncodedRun[] }> {
  const fs = new MemoryFs();
  const paths = sources.map((runs, i) => runs.map((_, j) => `in/${i}.${j}.sst`));
  for (const [i, runs] of sources.entries()) for (const [j, run] of runs.entries()) await publish(fs, paths[i]![j]!, run);
  const files = await Promise.all(paths.map((runs) => Promise.all(runs.map(async (p) => (await fs.open(p))!))));
  const core = await (options.open ?? openMerge)({
    sources: sources.map((runs) => runs.map(options.input ?? mergeInput)),
    dropTombstones: options.dropTombstones ?? false,
    marks: NO_MARKS,
    targetBytes: options.targetBytes ?? Number.MAX_SAFE_INTEGER,
    chunkBytes: 64 * 1024,
    tailBytes: 128 * 1024,
    yieldBytes: 1024 * 1024,
  });
  try {
    const outputs = await pumpMerge(fs, core, files, (i) => `out/${i}.sst`, () => 64 * 1024);
    const runs = await Promise.all(outputs.map(async ({ path, ...end }) => ({ body: (await fs.read(path, 0, Infinity))!, end })));
    return { runs };
  } finally {
    core.close();
    for (const file of files.flat()) file.close();
  }
}

import { pumpMerge } from "../src/host/compact.js";
import { MemoryFs } from "../src/opfs/memory-fs.js";
import type { AsyncFs } from "../src/opfs/async-fs.js";
import { untilHit, type LayerCursor, type LayerEntry } from "../src/store/cursor.js";
import { openMerge, type MergeCore, type MergeSpec } from "../src/store/engine.js";
import { NO_MARKS, type Marks } from "../src/store/marks.js";
import { PageCache } from "../src/store/page-cache.js";
import type { RunMeta } from "../src/store/generation.js";
import { encodeRun, sstKeyRange, type EncodedRun, type RunEnd, type SstCodec, type SstEntry } from "../src/store/sst.js";
import { bytesFile, SstReader } from "../src/store/sst-reader.js";

export { bytesFile };

const enc = new TextEncoder();
const bytesOf = (key: string | Uint8Array) => (typeof key === "string" ? enc.encode(key) : key);

/** The manifest entry of a run the encoder reported as `end`, at `path`. */
export function listed(path: string, end: RunEnd, marksThrough = 0): RunMeta {
  if (!end.stats) throw new Error("a listed run needs an entry");
  return { path, bytes: end.bytes, range: end.range, stats: end.stats, marksThrough };
}

/**
 * A manifest entry of `bytes` for a run of `entries`, or of a put at each
 * end of `[smallest, largest]` at seq 1, with the statistics its encoder
 * writes.
 */
export function listedRun(
  path: string,
  bytes: number,
  contents: { readonly smallest: string | Uint8Array; readonly largest?: string | Uint8Array } | readonly SstEntry[],
  marksThrough = 0,
): RunMeta {
  const entries: readonly SstEntry[] =
    "smallest" in contents
      ? [contents.smallest, contents.largest ?? contents.smallest].map((k) => ({ kind: "put", key: bytesOf(k), value: new Uint8Array(10), seq: 1 }))
      : contents;
  return { ...listed(path, encodeRun(entries).end, marksThrough), bytes };
}

/** A lazy reader over a run held in memory, routed by the range its manifest entry would record. */
export function readerOfBytes(buf: Uint8Array, cache = new PageCache()): SstReader {
  return new SstReader(bytesFile(buf), cache, sstKeyRange(buf));
}

/** Every entry left in `cursor`, waiting out its misses. */
export async function drain(cursor: LayerCursor): Promise<LayerEntry[]> {
  const out: LayerEntry[] = [];
  for (;;) {
    const e = await untilHit(() => cursor.peek());
    if (!e) return out;
    out.push(e);
    cursor.next();
  }
}

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
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
 */
export async function mergeRuns(
  sources: readonly (readonly Uint8Array[])[],
  options: {
    readonly dropTombstones?: boolean;
    readonly judgeNow?: number;
    readonly marks?: Marks;
    readonly targetBytes?: number;
    readonly codec?: SstCodec;
    readonly open?: (spec: MergeSpec) => MergeCore | Promise<MergeCore>;
  } = {},
): Promise<{ runs: EncodedRun[]; droppedSeq: number }> {
  const fs = new MemoryFs();
  const paths = sources.map((runs, i) => runs.map((_, j) => `in/${i}.${j}.sst`));
  for (const [i, runs] of sources.entries()) for (const [j, run] of runs.entries()) await publish(fs, paths[i]![j]!, run);
  const files = await Promise.all(paths.map((runs) => Promise.all(runs.map(async (p) => (await fs.open(p))!))));
  const core = await (options.open ?? openMerge)({
    sources: sources.map((runs) => runs.map((run) => run.byteLength)),
    dropTombstones: options.dropTombstones ?? false,
    judgeNow: options.judgeNow ?? 0,
    marks: options.marks ?? NO_MARKS,
    targetBytes: options.targetBytes ?? Number.MAX_SAFE_INTEGER,
    codec: options.codec ?? "raw",
    chunkBytes: 64 * 1024,
    tailBytes: 128 * 1024,
    yieldBytes: 1024 * 1024,
  });
  try {
    const { outputs, droppedSeq } = await pumpMerge(fs, core, files, (i) => `out/${i}.sst`);
    const runs = await Promise.all(outputs.map(async ({ path, ...end }) => ({ body: (await fs.read(path, 0, Infinity))!, end })));
    return { runs, droppedSeq };
  } finally {
    core.close();
    for (const file of files.flat()) file.close();
  }
}

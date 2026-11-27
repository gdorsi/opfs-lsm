import { ConstraintError } from "../errors.js";
import { TARGET_RUN_BYTES } from "../store/levels.js";

const KiB = 1024;
const MiB = 1024 * KiB;

/** What `openDb` assumes when the app sets no `compactionMemoryBytes`. */
export const DEFAULT_COMPACTION_MEMORY_BYTES = 32 * MiB;

/** The app's `compactionMemoryBytes`, or the default unless it is positive. The tab normalizes it once, before it tells the host. */
export function compactionMemoryOf(asked: number | undefined): number {
  return asked !== undefined && asked > 0 ? asked : DEFAULT_COMPACTION_MEMORY_BYTES;
}

/**
 * What `openDb` keeps in the reserve file when the app sets no
 * `reserveBytes`. A database filled to the limit needs room to flush its WAL
 * and to compact before a delete frees a byte: the flush run and the
 * compaction outputs are written before their inputs go.
 */
const DEFAULT_RESERVE_BYTES = 24 * MiB;

/** The app's `reserveBytes`, or the default. `ConstraintError` unless it is an integer of at least 0. */
export function reserveOf(asked: number | undefined): number {
  const bytes = asked ?? DEFAULT_RESERVE_BYTES;
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new ConstraintError("reserveBytes must be an integer of at least 0");
  return bytes;
}

/**
 * Every openDb replays the whole uningested WAL on the tab's main thread, at
 * a cost per row. 1 MiB keeps that replay near 40 ms with ~100-byte ops
 * (measured on Yjs docs: 4 MiB opened in 71-91 ms, 1 MiB in 39-44 ms,
 * 256 KiB in 25-39 ms). Lower limits mean more ingests and L0 compactions
 * for little more open time saved.
 */
export const DEFAULT_MAX_WAL_BYTES = MiB;

/**
 * A database with no row from any tab for this long is flushed, when at
 * least `maxWalBytes / IDLE_FLUSH_SHARE` wait. A fresh tab replays the tail
 * before `openDb` resolves, and reads a flushed row from a run page instead
 * of memory: below the share, the open saves less than that first page costs.
 */
export const IDLE_FLUSH_MS = 2000;
export const IDLE_FLUSH_SHARE = 8;

/**
 * The longest a row waits for that flush while rows keep coming. A writer
 * that never pauses for `IDLE_FLUSH_MS`, such as a typist, would otherwise
 * leave up to `maxWalBytes` of small records for the next open to replay.
 */
export const IDLE_FLUSH_DUE_MS = 5000;

/**
 * Below this a step would merge fewer than 18 sources, and a stop at one
 * less would hold writes after 17 flush runs.
 */
export const MIN_COMPACTION_MEMORY_BYTES = 8 * MiB;

/** What the host holds to keep its working set under the app's budget. */
export type HostBudget = {
  /**
   * How much of each merge source a step reads at once, and the most a
   * `write` stop carries. The session holds about this much per source in
   * wasm, and up to this much per source is in flight in JS, plus two more
   * in a step that overlaps its file waits (`pumpMerge`).
   */
  readonly chunkBytes: number;
  /** How much of a run's end a merge reads first. Never above `chunkBytes`, or every source's window grows to it. */
  readonly tailBytes: number;
  /** The most sources one merge step reads: the L0 runs it takes plus one L1 source. */
  readonly maxSources: number;
  /** Op bytes of WAL records folded into one L0 run. A larger backlog becomes several runs. */
  readonly flushRunBytes: number;
  /**
   * L0 runs at which a flush waits for a compaction step to install before it
   * publishes another. One less than `maxSources`, so one step can take all of
   * L0. A step takes the L0 runs that exist when it starts, and a stop at S
   * settles near S/2 runs per step, so a low stop cuts steps short and each
   * one rewrites all of L1.
   */
  readonly l0StopRuns: number;
  /** About how many input bytes a step merges between turns of the event loop. */
  readonly yieldBytes: number;
  /** Wasm memory past which the engine is re-instantiated at the next idle point. */
  readonly wasmRecycleBytes: number;
};

/** The wasm module's memory when idle. */
const MODULE_BYTES = 1 * MiB;
/**
 * The footprint of a run of F op bytes in a flush, rounded up. About 5.4F is
 * wasm memory (measured: a 1.75 MiB run of 116-byte ops peaks at 9.4 MiB, module
 * included) and about 3F is JS: the WAL records read, the folded entries and
 * the copy of the result. Smaller ops cost more, because the encoder keeps a
 * few dozen bytes per entry: the same run peaks at 18 MiB with 40-byte ops.
 * A flush chunk counts an op as at least 32 bytes, which keeps it there.
 */
const FLUSH_COST = 10;
/** The block buffers and slots a merge session keeps per source, besides the source's window. */
const SOURCE_BYTES = 16 * KiB;
const MIN_CHUNK_BYTES = 64 * KiB;
const MAX_CHUNK_BYTES = 256 * KiB;
const CHUNK_STEP = 32 * KiB;
/** Usually a run's whole footer and bloom, so one read opens it. */
const TAIL_BYTES = 128 * KiB;
/**
 * The most sources a step reads. A step reads all of L1 with random keys, so
 * it should take many L0 runs. The sweep that chose this went no higher, so
 * a larger budget buys no more.
 */
const MAX_SOURCES = 49;
const YIELD_BYTES = 1 * MiB;

/**
 * Every figure the host derives from `compactionMemoryBytes` (B), the memory
 * a SharedWorker may spend on flushing and compacting: its wasm heap and the
 * run data in flight in JS. This is the only place the formula lives.
 *
 * A flush and a merge session share one wasm instance and can overlap, so B
 * covers the module and both:
 *
 *   B = W0 + 10F + S(2C + K)
 *
 * with F the flush run size, S the sources of a step, C the window per
 * source (held in wasm, and read in JS before it is fed), and K the
 * per-source buffers. The input region, which holds every input run's
 * index, has no term: indexes are small next to C unless keys are long
 * and share long prefixes. The figures follow from it.
 *
 * - F is 7/8 of min(T, B/16), T being the compaction output run (4 MiB). Wasm
 *   memory grows in steps at power-of-two input sizes, and a run's packed
 *   input is about 1.15F, so an F at 7/8 of a power of two stays under a
 *   step. A 2 MiB run peaks at 16.1 MiB where a 1.75 MiB run peaks at 9.4.
 * - S is the cap, 49, unless the smallest window cannot fit that many.
 * - C is what the merge share has left per source, between 64 KiB and
 *   256 KiB, in steps of 32 KiB.
 * - The L0 stop is S - 1.
 * - Recycling at B/2 sits above what a flush or a merge needs alone (10 and
 *   8 MiB at the default) and below what they need together (16.3 MiB). It
 *   fires after an overlap, not after every flush.
 *
 * A figure below the minimum counts as the minimum.
 * Past 64 MiB only the recycle threshold grows: the sweep that chose the
 * cap on S measured no higher.
 */
export function hostBudget(compactionMemoryBytes: number): HostBudget {
  const b = Math.max(MIN_COMPACTION_MEMORY_BYTES, compactionMemoryBytes);
  const flushRunBytes = Math.floor((Math.min(TARGET_RUN_BYTES, b / 16) * 7) / 8);
  const merge = b - MODULE_BYTES - FLUSH_COST * flushRunBytes;
  const maxSources = Math.min(MAX_SOURCES, Math.floor(merge / (2 * MIN_CHUNK_BYTES + SOURCE_BYTES)));
  const window = (merge / maxSources - SOURCE_BYTES) / 2;
  const chunkBytes = Math.min(MAX_CHUNK_BYTES, Math.max(MIN_CHUNK_BYTES, Math.floor(window / CHUNK_STEP) * CHUNK_STEP));
  return {
    chunkBytes,
    tailBytes: Math.min(TAIL_BYTES, chunkBytes),
    maxSources,
    flushRunBytes,
    l0StopRuns: maxSources - 1,
    yieldBytes: YIELD_BYTES,
    wasmRecycleBytes: Math.floor(b / 2),
  };
}

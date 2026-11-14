/**
 * Types shared by the page (runs workloads) and the driver (plans runs,
 * summarizes records). Nothing here touches a browser or Node API.
 *
 * Ids come from file paths: `workloads/kv/fillrandom.ts` is "kv/fillrandom",
 * `contenders/kv/idb.ts` is "kv/idb". There is no registry file.
 */
import type { KvStats } from "@opfs-lsm/kv/testing";
import type { FamilyStores } from "./families.ts";
import type { Model } from "../page/model.ts";

/** The directory name under `workloads/` and `contenders/`. */
export type Family = keyof FamilyStores;

/** tiny = CI smoke, small = default, large = db_bench scale. */
export type SizeName = "tiny" | "small" | "large";
export const SIZES: readonly SizeName[] = ["tiny", "small", "large"];

/**
 * Durability as the contender ships it, printed next to every number. kv's
 * WAL commits IndexedDB transactions with the browser default, which Chrome
 * has made relaxed since version 121. "sqlite-full" is SQLite's default
 * `synchronous=FULL` with a rollback journal, on OPFS; "sqlite-off" is `synchronous=OFF`.
 */
export type Durability = "idb-default" | "idb-strict" | "sqlite-full" | "sqlite-off" | "none";

/** Sizing in the LevelDB setup-line vocabulary. */
export type Params = {
  readonly entries: number;
  readonly keyBytes: number;
  readonly valueBytes: number;
  /** Fraction of each value that is a repeated byte. 0.5 ≈ LevelDB's "compressible to half". */
  readonly compressibility: number;
  /** Ops per write batch (one kv batch, one IDB transaction, one bulkPut). Same for every contender. */
  readonly batch: number;
  /** Ops in a timed read or mixed phase. */
  readonly ops: number;
  readonly seed: number;
};

// ---------------------------------------------------------------- contender

/**
 * One storage implementation of a family's store interface. `open` must use
 * the library's documented fast path; `fastPath` says in one line what that
 * is, and the report prints it next to the numbers.
 */
export type Contender<F extends Family> = {
  readonly family: F;
  readonly durability: Durability;
  readonly fastPath: string;
  /** True for contenders whose store reports kv engine counters. */
  readonly engine: boolean;
  open(name: string, params: Params): Promise<FamilyStores[F]>;
};

export function defineContender<F extends Family>(c: Contender<F>): Contender<F> {
  return c;
}

// ---------------------------------------------------------------- workload

/**
 * Where a phase runs. "fresh" closes the tab, waits until every SharedWorker
 * has exited, then opens a new tab: a cold page over warm OS storage.
 */
export type PageMode = "same" | "fresh";

export type Phase<F extends Family> = {
  /** db_bench-style name, printed in the report ("fillrandom", "readrandom"). */
  readonly name: string;
  readonly page: PageMode;
  /** Untimed phases (settle) still verify reads but report no throughput. */
  readonly timed: boolean;
  /** Record disk footprint and engine counters at the end of this phase. */
  readonly footprint?: boolean;
  /**
   * Report the main thread's long tasks during this phase. Opt in only for
   * phases that model a user interaction: a loop of thousands of awaited
   * calls with no yield is one giant task, which is not a user metric.
   */
  readonly mainThread?: boolean;
  run(ctx: PhaseContext<F>): Promise<void>;
};

export type Workload<F extends Family> = {
  readonly family: F;
  /** One line, plain words. Printed above the table. */
  readonly title: string;
  readonly params: (size: SizeName) => Params;
  /** Run only these contenders (bare names, e.g. "kv"). Default: every contender of the family. */
  readonly contenders?: readonly string[];
  readonly phases: readonly Phase<F>[];
};

export function defineWorkload<F extends Family>(w: Workload<F>): Workload<F> {
  return w;
}

/**
 * What a phase body gets. The context owns timing, op counting, the
 * correctness model and the open store, so a workload body is just the ops.
 */
export type PhaseContext<F extends Family> = {
  readonly params: Params;
  readonly size: SizeName;
  /** Opens on the first call in this page; the open is timed as op "open". */
  store(): Promise<FamilyStores[F]>;
  /** Deterministic keys, values and the expected state. Carried to fresh pages. */
  readonly model: Model;
  /** Seeded per (workload, phase, rep), not per contender: every contender replays the same ops. */
  readonly rng: () => number;
  /**
   * Time one awaited call into the histogram for `op`. It counts as `count`
   * ops (a batch of 1000 puts is one call, 1000 ops) and adds `userBytes`.
   * The store open is timed as op "open" and never counts as an op.
   */
  time<T>(op: string, userBytes: number, fn: () => Promise<T>, count?: number): Promise<T>;
  /** Count bytes handed to storage outside ctx.time (a CRDT's saves): the W-Amp denominator. */
  bytes(n: number): void;
  /** Add `n` to the phase's counter `name`, for facts that are not a latency (storage calls, library CPU). The report prints them next to the phase. */
  count(name: string, n: number): void;
  /** Fails the run: it never reports a number. */
  check(ok: boolean, what: string): void;
  /** Opaque JSON a phase hands to later phases (for workloads that do not use the model). */
  carry: Record<string, unknown>;
  /** One progress line to the driver. */
  progress(line: string): void;
};

// ---------------------------------------------------------------- results

/** Log-linear histogram of microseconds. Mergeable across runs by adding counts. */
export type HistogramSnapshot = {
  readonly n: number;
  readonly sumUs: number;
  readonly minUs: number;
  readonly maxUs: number;
  /** [bucket index, count], sparse. */
  readonly buckets: readonly (readonly [number, number])[];
};

export type Footprint = {
  /** Every OPFS file under the origin root, orphans included. Exact. */
  readonly opfsBytes: number;
  /** navigator.storage.estimate().usageDetails.indexedDB. Approximate. */
  readonly idbEstimateBytes: number;
  /** Live keys × (key + value), from the model. The Space-Amp denominator. */
  readonly liveLogicalBytes: number;
  /**
   * kv counters at the end of the phase. They count from the moment this
   * page opened the db (tab) and the SharedWorker started (host), so they
   * cover every phase since the last fresh page.
   */
  readonly kv?: KvStats;
};

/**
 * The tab's main thread during a phase. Long tasks are the ones over 50 ms, and
 * blockedMs sums each one's time past 50 ms. Frames are requestAnimationFrame
 * callbacks. frameIntervalMs is the median step of their vsync timestamps, and
 * droppedFrames sums round(gap / frameIntervalMs) - 1 over the gaps between
 * the times the callbacks ran, which catches blocks too short for a long task.
 */
export type MainThread = {
  readonly longTasks: number;
  readonly longestMs: number;
  readonly blockedMs: number;
  readonly frames: number;
  readonly frameIntervalMs: number;
  readonly longestFrameMs: number;
  readonly droppedFrames: number;
};

export type PhaseResult = {
  readonly name: string;
  readonly page: PageMode;
  readonly timed: boolean;
  readonly wallMs: number;
  /** Ops done in the phase (entries, not calls), not counting the open. */
  readonly ops: number;
  readonly userBytes: number;
  readonly latency: Readonly<Record<string, HistogramSnapshot>>;
  readonly footprint?: Footprint;
  readonly mainThread?: MainThread;
  /** Named totals the phase counted with `ctx.count`. */
  readonly counters?: Readonly<Record<string, number>>;
};

export type HostInfo = {
  readonly chrome: string;
  readonly headless: boolean;
  readonly os: string;
  readonly cpu: string;
  readonly cores: number;
  readonly loadAvg1: number;
  readonly node: string;
  readonly gitSha: string;
};

/** Peaks of V8's `Runtime.getHeapUsage`, sampled every 100 ms. Missing optional fields: Chrome did not report them. */
export type HeapPeak = {
  readonly usedSize: number;
  readonly totalSize: number;
  readonly embedderHeapUsedSize?: number;
  /** ArrayBuffer and wasm memory bytes. Absent when Chrome does not report it. */
  readonly backingStorageSize?: number;
  readonly samples: number;
};

/** Peaks over one Chrome run (all phases). The SharedWorker is the kv host; a tab peak is the largest of any tab. */
export type MemoryPeaks = {
  readonly sharedWorker: HeapPeak | null;
  /** Largest `memory.buffer.byteLength` of a wasm instance in the SharedWorker. Wasm memory never shrinks, so this is its peak. */
  readonly sharedWorkerWasmBytes: number | null;
  readonly tab: HeapPeak | null;
  readonly tabWasmBytes: number | null;
  /**
   * Peak memory of the single largest renderer process (the SharedWorker's or a tab's), read once a second.
   * On macOS it is `phys_footprint_peak`, the kernel's own peak since the process started. Elsewhere it is the largest RSS seen.
   */
  readonly largestRendererBytes: number | null;
};

/** One line of `bench/results/<stamp>.jsonl`. One run = one fresh Chrome profile. */
export type RunRecord = {
  readonly workload: string;
  readonly contender: string;
  readonly durability: Durability;
  readonly fastPath: string;
  readonly size: SizeName;
  readonly rep: number;
  readonly params: Params;
  readonly host: HostInfo;
  readonly phases: readonly PhaseResult[];
  readonly memory?: MemoryPeaks;
  /** Set when the run failed (correctness, timeout, crash). Failed runs never feed a median. */
  readonly error?: string;
};

// ---------------------------------------------------------------- page protocol

/** What `__bench.catalog()` returns: derived from import.meta.glob. */
export type Catalog = readonly {
  readonly workload: string;
  readonly family: Family;
  readonly title: string;
  readonly phases: readonly { readonly name: string; readonly page: PageMode }[];
  readonly contenders: readonly string[];
}[];

/** Driver → page, one per phase. `carry` is the state the previous phase handed back. */
export type PhaseRequest = {
  readonly workload: string;
  readonly contender: string;
  readonly size: SizeName;
  readonly rep: number;
  readonly phase: number;
  readonly dbName: string;
  readonly carry: string | undefined;
};

export type PhaseReply = {
  readonly result: PhaseResult;
  readonly carry: string;
  readonly durability: Durability;
  readonly fastPath: string;
  readonly params: Params;
};

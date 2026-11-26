import { checkDbName, type DbName } from "../check.js";
import { openExistingWal } from "../idb/wal.js";
import type { FileWrites } from "../opfs/async-fs.js";
import { CountingFs, emptyIoCounters, type IoCounters } from "../opfs/counting-fs.js";
import { GENERATION_NONE, type Generation } from "../seq.js";
import { engineMemoryBytes, watchEngine } from "../store/engine.js";
import { loadGeneration } from "../store/generation.js";
import { levelOf } from "../store/levels.js";
import { destroyed, EngineHost, type FsFactory, type HostOptions, type Meter } from "./engine-host.js";
import type { HostStats } from "./protocol.js";

/** What this context's engine dropped, recycled and reserved since this module loaded. */
const engineFigures = { droppedPeakBytes: 0, mergeReservedBytes: 0, recycles: 0 };
watchEngine({
  dropped(bytes) {
    engineFigures.droppedPeakBytes = Math.max(engineFigures.droppedPeakBytes, bytes);
  },
  recycled() {
    engineFigures.recycles += 1;
  },
  reserved(bytes) {
    engineFigures.mergeReservedBytes = Math.max(engineFigures.mergeReservedBytes, bytes);
  },
});

/** This context's wasm engine, shared by every database it serves, for `HostStats.memory`. */
export function engineMemory(): HostStats["memory"] {
  const wasmBytes = engineMemoryBytes();
  const { droppedPeakBytes, mergeReservedBytes, recycles } = engineFigures;
  return { wasmBytes, wasmPeakBytes: Math.max(droppedPeakBytes, wasmBytes), mergeReservedBytes, recycles };
}

/** What a meter counted for one database. */
type Counts = Pick<HostStats, "flushes" | "l0Stops" | "compactionSteps" | "foldedBytes"> & { readonly io: IoCounters };

const zero = (): Counts => ({ io: emptyIoCounters(), flushes: 0, l0Stops: 0, compactionSteps: 0, foldedBytes: 0 });

function countingMeter(counted: Map<DbName, Counts>): Meter {
  const of = (name: DbName) => {
    let counts = counted.get(name);
    if (!counts) counted.set(name, (counts = zero()));
    return counts;
  };
  return {
    fs: (name, inner) => new CountingFs(inner, of(name).io),
    flushed(name, chunk) {
      const counts = of(name);
      if (chunk.kind === "stopped") counts.l0Stops += 1;
      if (chunk.kind === "folded") counts.flushes += 1;
      counts.foldedBytes += chunk.foldedBytes;
    },
    compacted(name) {
      of(name).compactionSteps += 1;
    },
  };
}

/**
 * The host of tests, benches and the metered SharedWorker: the shipped host
 * with a meter, so `stats` answers. `@opfs-lsm/kv/testing` exports it as `EngineHost`.
 */
export class MeteredHost extends EngineHost {
  private readonly counted: Map<DbName, Counts>;
  private readonly folder: FsFactory;

  /** `fileWrites` is how the worker writes OPFS files, for `stats`. */
  constructor(
    fsFactory: FsFactory,
    overrides?: HostOptions,
    private readonly fileWrites?: FileWrites,
  ) {
    const counted = new Map<DbName, Counts>();
    super(fsFactory, overrides, countingMeter(counted));
    this.counted = counted;
    this.folder = fsFactory;
  }

  /**
   * What this host counted for `name` since it started. `generation` and
   * `layout` describe the recorded generation; their manifest read bypasses
   * the counters.
   */
  override async stats(name: string): Promise<HostStats> {
    const dbName = checkDbName(name);
    const wal = await openExistingWal(dbName);
    if (!wal) throw destroyed();
    let recorded: Generation;
    try {
      recorded = (await wal.meta()).generation ?? GENERATION_NONE;
    } finally {
      wal.close();
    }
    const fs = await this.folder(dbName);
    if (!fs) throw destroyed();
    const latest = await loadGeneration(fs, recorded);
    const byLevel = new Map<number, { level: number; runs: number; bytes: number }>();
    for (const run of latest?.runs ?? []) {
      const level = levelOf(run.path) ?? 0;
      const entry = byLevel.get(level) ?? { level, runs: 0, bytes: 0 };
      entry.runs += 1;
      entry.bytes += run.bytes;
      byLevel.set(level, entry);
    }
    const { io, ...counts } = this.counted.get(dbName) ?? zero();
    return structuredClone({
      fs: io,
      ...counts,
      ...(this.fileWrites ? { fileWrites: this.fileWrites } : {}),
      generation: latest?.generation ?? GENERATION_NONE,
      layout: [...byLevel.values()].sort((a, b) => a.level - b.level),
      memory: engineMemory(),
    });
  }
}

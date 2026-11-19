/**
 * Pure: run records → every per-run number the suite reports. A `Series` is
 * the values of one metric at one address, one value per successful run.
 * `report` and `compare` read series and never compute a number themselves, so
 * a number has one formula. Records hold raw facts only; everything here is
 * derived at read time, so fixing a formula re-derives old result files.
 *
 * Amplification follows docs/research/benchmark-prior-art.md section 2.2:
 *
 *   W-Amp engine = (flush + compaction bytes written) / user bytes in
 *   W-Amp total  = (WAL + flush + compaction + manifest bytes) / user bytes in
 *   Compaction   = compaction bytes written / flush bytes written
 *   Read-Amp     = L0 runs + non-empty deeper levels (structural)
 *   Space-Amp    = bytes on disk / live logical bytes
 *
 * kv counters cover everything since the page opened the db, so user bytes
 * are summed over the phases of the same page up to the footprint phase.
 */
import type { IoCounters } from "@opfs-lsm/kv/testing";
import { opsOf, samplesOf } from "../core/histogram.ts";
import { SIZES, type PhaseResult, type RunRecord, type SizeName } from "../core/types.ts";

const MAIN_FIELDS = ["longTasks", "longestMs", "blockedMs", "longestFrameMs", "droppedFrames"] as const;
const AMP_FIELDS = [
  "wampEngine", "wampTotal", "compaction", "readAmp", "spaceAmp", "walBytes", "flushBytes", "compactionBytes", "diskBytes", "userBytes", "liveBytes",
] as const;
const MEM_FIELDS = ["sharedWorkerTotal", "tabTotal", "largestRenderer"] as const;

type MainField = (typeof MAIN_FIELDS)[number];
type AmpField = (typeof AMP_FIELDS)[number];
type MemField = (typeof MEM_FIELDS)[number];

/** Without kv counters a footprint holds only what navigator.storage.estimate() and the model know. */
const APPROX_AMP_FIELDS: readonly AmpField[] = ["spaceAmp", "diskBytes", "userBytes", "liveBytes"];

/**
 * rate          phase ops per second over the wall time minus the store open
 * wall          phase wall ms
 * mean:<op>     the run's mean latency of one op, ms
 * main:<field>  the tab's main thread during the phase
 * amp:<field>   amplification and bytes at the end of the phase
 * mem:<field>   peaks over the whole run, not tied to a phase
 */
export type Metric = "rate" | "wall" | `mean:${string}` | `main:${MainField}` | `amp:${AmpField}` | `mem:${MemField}`;

export type At = {
  readonly workload: string;
  readonly size: SizeName;
  readonly contender: string;
  /** Absent for a run-level metric. */
  readonly phase?: string;
  readonly metric: Metric;
};

export type Range = { readonly median: number; readonly min: number; readonly max: number; readonly n: number };

/**
 * `clusters` is set when at least 5 values split at their largest gap into
 * two sides of at least 2 values each, and that gap is wider than each side's
 * own min–max range and than a tenth of the median: the runs landed in two
 * states, and one median hides it.
 */
export type Summary = Range & { readonly clusters?: readonly [Range, Range] };

export type Series = {
  readonly at: At;
  /** One per successful run, in file order, finite values only. */
  readonly values: readonly number[];
  readonly summary: Summary;
  /** From navigator.storage.estimate(), not from counters. */
  readonly approx: boolean;
};

export type Measures = {
  /** Sorted by workload, size, phase order, contender, then metric. */
  readonly all: readonly Series[];
  get(at: At): Series | undefined;
};

export type Direction = "higher" | "lower";

export type MetricInfo = {
  readonly direction: Direction;
  /** False for counts, where a ratio of medians says little. */
  readonly ratio: boolean;
  /** Three significant digits or the unit's usual precision; `withUnit` false prints the bare number. */
  format(x: number, withUnit?: boolean): string;
};

/** `times` is how many times better b is than a. `distinct` is false when the min–max ranges overlap. */
export type Verdict = { readonly times: number; readonly distinct: boolean };

// ---------------------------------------------------------------- formats

const fmtN = (x: number) =>
  !Number.isFinite(x) ? "–" : x >= 100_000 ? `${(x / 1000).toFixed(0)}k` : x >= 10_000 ? `${(x / 1000).toFixed(1)}k` : x >= 100 ? x.toFixed(0) : x.toFixed(1);
const fmtCount = (x: number) => (!Number.isFinite(x) ? "–" : Number.isInteger(x) ? String(x) : x.toFixed(1));
const fmtX = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "–");
const fmtMB = (b: number) => (Number.isFinite(b) ? (b / 1e6).toFixed(1) : "–");
const fmtMs = (x: number) => (!Number.isFinite(x) ? "–" : x >= 1000 ? fmtN(x) : x.toPrecision(3));

// ---------------------------------------------------------------- amplification

type Sample = { readonly run: RunRecord; /** The phase's index in the run; -1 for a run-level sample. */ readonly index: number };

const phaseOf = (s: Sample): PhaseResult | undefined => s.run.phases[s.index];

function sumClass(c: IoCounters["written"], pred: (cls: string) => boolean): number {
  return Object.entries(c).reduce((t, [cls, v]) => (pred(cls) ? t + v.bytes : t), 0);
}

const isDeeper = (cls: string) => /^l[1-9]\d*$/.test(cls);

function amplification(s: Sample): Record<AmpField, number> | undefined {
  const p = phaseOf(s);
  const fp = p?.footprint;
  if (!p || !fp) return undefined;
  let userIn = 0;
  for (let i = s.index; i >= 0; i--) {
    const q = s.run.phases[i]!;
    // A later phase runs in the tab of the last round, so that round's writes are the ones its counters hold.
    userIn += (i < s.index ? (q.laterRounds?.at(-1) ?? q) : q).userBytes;
    if (q.page === "fresh") break;
  }
  const kv = fp.kv;
  if (!kv) {
    const disk = fp.idbEstimateBytes + fp.opfsBytes;
    return {
      wampEngine: NaN, wampTotal: NaN, compaction: NaN, readAmp: NaN, walBytes: NaN, flushBytes: NaN, compactionBytes: NaN,
      spaceAmp: disk / fp.liveLogicalBytes, diskBytes: disk, userBytes: userIn, liveBytes: fp.liveLogicalBytes,
    };
  }
  const w = kv.host.fs.written;
  const flush = sumClass(w, (cls) => cls === "l0");
  const compaction = sumClass(w, isDeeper);
  const manifest = sumClass(w, (cls) => cls === "m");
  const wal = kv.tab.walBytes;
  const l0 = kv.host.layout.find((l) => l.level === 0)?.runs ?? 0;
  const deeper = kv.host.layout.filter((l) => l.level > 0 && l.runs > 0).length;
  return {
    wampEngine: (flush + compaction) / userIn,
    wampTotal: (wal + flush + compaction + manifest) / userIn,
    compaction: compaction / flush,
    readAmp: l0 + deeper,
    spaceAmp: fp.opfsBytes / fp.liveLogicalBytes,
    walBytes: wal,
    flushBytes: flush,
    compactionBytes: compaction,
    diskBytes: fp.opfsBytes,
    userBytes: userIn,
    liveBytes: fp.liveLogicalBytes,
  };
}

// ---------------------------------------------------------------- kinds

/** Each metric kind says how its series are listed, valued, directed and formatted. */
type KindSpec = {
  readonly scope: "phase" | "run";
  readonly direction: Direction;
  readonly ratio: (id: string) => boolean;
  /** The ids (the part after "kind:") that have a series, given every run's sample. */
  readonly ids: (samples: readonly Sample[]) => readonly string[];
  /** NaN when this run has no value; such values are dropped. */
  readonly value: (s: Sample, id: string) => number;
  readonly approx?: (s: Sample) => boolean;
  readonly unit: (id: string) => string;
  readonly format: (x: number, id: string) => string;
};

type Kind = "rate" | "wall" | "mean" | "main" | "amp" | "mem";

const timed = (samples: readonly Sample[]) => samples.filter((s) => phaseOf(s)?.timed);
const once = (ok: boolean) => (ok ? [""] : []);

const KINDS: { [K in Kind]: KindSpec } = {
  rate: {
    scope: "phase",
    direction: "higher",
    ratio: () => true,
    ids: (ss) => once(timed(ss).some((s) => (phaseOf(s)?.ops ?? 0) > 0)),
    value: (s) => {
      const p = phaseOf(s);
      return p?.timed && p.ops > 0 ? (p.ops / (p.wallMs - (p.latency.open?.sumUs ?? 0) / 1000)) * 1000 : NaN;
    },
    unit: () => " ops/s",
    format: fmtN,
  },
  wall: {
    scope: "phase",
    direction: "lower",
    ratio: () => true,
    ids: (ss) => once(timed(ss).length > 0),
    value: (s) => {
      const p = phaseOf(s);
      return p?.timed ? p.wallMs : NaN;
    },
    unit: () => " ms",
    format: fmtN,
  },
  mean: {
    scope: "phase",
    direction: "lower",
    ratio: () => true,
    ids: (ss) => [...new Set(timed(ss).flatMap((s) => opsOf(phaseOf(s)!)))],
    value: (s, op) => {
      const p = phaseOf(s);
      const samples = p?.timed ? samplesOf(p, op) : [];
      const n = samples.reduce((t, h) => t + h.n, 0);
      return n > 0 ? samples.reduce((t, h) => t + h.sumUs, 0) / n / 1000 : NaN;
    },
    unit: () => " ms",
    format: fmtMs,
  },
  main: {
    scope: "phase",
    direction: "lower",
    ratio: (f) => f !== "longTasks" && f !== "droppedFrames",
    ids: (ss) => (ss.some((s) => phaseOf(s)?.mainThread) ? MAIN_FIELDS : []),
    value: (s, f) => phaseOf(s)?.mainThread?.[f as MainField] ?? NaN,
    unit: (f) => (f === "longTasks" || f === "droppedFrames" ? "" : " ms"),
    format: (x, f) => (f === "longTasks" || f === "droppedFrames" ? fmtCount(x) : fmtN(x)),
  },
  amp: {
    scope: "phase",
    direction: "lower",
    ratio: () => true,
    ids: (ss) => {
      const fps = ss.map((s) => phaseOf(s)?.footprint).filter((fp) => fp !== undefined);
      return fps.length === 0 ? [] : fps.some((fp) => fp.kv) ? AMP_FIELDS : APPROX_AMP_FIELDS;
    },
    value: (s, f) => amplification(s)?.[f as AmpField] ?? NaN,
    approx: (s) => phaseOf(s)?.footprint?.kv === undefined,
    unit: (f) => (f.endsWith("Bytes") ? " MB" : f === "readAmp" ? "" : "×"),
    format: (x, f) => (f.endsWith("Bytes") ? fmtMB(x) : f === "readAmp" ? fmtN(x) : fmtX(x)),
  },
  mem: {
    scope: "run",
    direction: "lower",
    ratio: () => true,
    ids: (ss) => (ss.some((s) => s.run.memory) ? MEM_FIELDS : []),
    value: ({ run }, f) => {
      const m = run.memory;
      if (!m) return NaN;
      const peak = (heap: typeof m.sharedWorker, wasm: number | null) =>
        heap ? heap.usedSize + (heap.backingStorageSize ?? 0) + (wasm ?? 0) : NaN;
      switch (f as MemField) {
        case "sharedWorkerTotal": return peak(m.sharedWorker, m.sharedWorkerWasmBytes);
        case "tabTotal": return peak(m.tab, m.tabWasmBytes);
        case "largestRenderer": return m.largestRendererBytes ?? NaN;
      }
    },
    unit: () => " MB",
    format: fmtMB,
  },
};

function resolve(metric: Metric): { spec: KindSpec; id: string } {
  const i = metric.indexOf(":");
  const kind = i < 0 ? metric : metric.slice(0, i);
  if (!Object.hasOwn(KINDS, kind)) throw new Error(`unknown metric "${metric}"`);
  return { spec: KINDS[kind as Kind], id: i < 0 ? "" : metric.slice(i + 1) };
}

export function describe(metric: Metric): MetricInfo {
  const { spec, id } = resolve(metric);
  return {
    direction: spec.direction,
    ratio: spec.ratio(id),
    format: (x, withUnit = true) => spec.format(x, id) + (withUnit ? spec.unit(id) : ""),
  };
}

// ---------------------------------------------------------------- statistics

function rangeOf(sorted: readonly number[]): Range {
  const m = sorted.length >> 1;
  return {
    median: sorted.length % 2 ? sorted[m]! : (sorted[m - 1]! + sorted[m]!) / 2,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    n: sorted.length,
  };
}

/** A few runs always split somewhere. Below this share of the median, a gap is noise. */
const MIN_CLUSTER_GAP = 0.1;

function summarize(values: readonly number[]): Summary {
  const sorted = [...values].sort((a, b) => a - b);
  const all = rangeOf(sorted);
  if (sorted.length < 5) return all;
  let cut = 1;
  let gap = -1;
  for (let i = 1; i < sorted.length; i++) {
    const g = sorted[i]! - sorted[i - 1]!;
    if (g > gap) {
      gap = g;
      cut = i;
    }
  }
  if (cut < 2 || sorted.length - cut < 2) return all;
  const lo = rangeOf(sorted.slice(0, cut));
  const hi = rangeOf(sorted.slice(cut));
  const split = gap > lo.max - lo.min && gap > hi.max - hi.min && gap > MIN_CLUSTER_GAP * Math.abs(all.median);
  return split ? { ...all, clusters: [lo, hi] } : all;
}

/**
 * b against a, by the metric's direction. The ranges decide `distinct`, the
 * medians `times`. A side with one run has no range, so it is never distinct.
 */
export function versus(a: Series, b: Series): Verdict {
  const higher = describe(a.at.metric).direction === "higher";
  return {
    times: higher ? b.summary.median / a.summary.median : a.summary.median / b.summary.median,
    distinct: a.summary.n > 1 && b.summary.n > 1 && (b.summary.min > a.summary.max || b.summary.max < a.summary.min),
  };
}

// ---------------------------------------------------------------- measure

const keyOf = (at: At) => [at.workload, at.size, at.contender, at.phase ?? "", at.metric].join("\0");

/** Every series the records hold. Failed runs are skipped. Throws when a run has two phases of one name. */
export function measure(records: readonly RunRecord[]): Measures {
  const groups = new Map<string, RunRecord[]>();
  for (const r of records) {
    if (r.error) continue;
    const dup = r.phases.find((p, i) => r.phases.findIndex((q) => q.name === p.name) !== i);
    if (dup) throw new Error(`${r.workload} ${r.contender}: two phases are named "${dup.name}"`);
    const key = `${r.workload}\0${r.size}\0${r.contender}`;
    const group = groups.get(key);
    if (group) group.push(r);
    else groups.set(key, [r]);
  }

  const entries: { series: Series; order: number }[] = [];
  const add = (base: Omit<At, "phase" | "metric">, phase: string | undefined, order: number, samples: readonly Sample[]) => {
    for (const [kind, spec] of Object.entries(KINDS) as [Kind, KindSpec][]) {
      if (spec.scope !== (phase === undefined ? "run" : "phase")) continue;
      for (const id of spec.ids(samples)) {
        const metric = (id ? `${kind}:${id}` : kind) as Metric;
        const used = samples.map((s) => ({ s, v: spec.value(s, id) })).filter((x) => Number.isFinite(x.v));
        if (used.length === 0) continue;
        const values = used.map((x) => x.v);
        const at: At = phase === undefined ? { ...base, metric } : { ...base, phase, metric };
        entries.push({
          series: { at, values, summary: summarize(values), approx: used.some((x) => spec.approx?.(x.s) ?? false) },
          order,
        });
      }
    }
  };

  for (const runs of groups.values()) {
    const first = runs[0]!;
    const base = { workload: first.workload, size: first.size, contender: first.contender };
    const names = new Map<string, number>();
    for (const r of runs) r.phases.forEach((p, i) => names.has(p.name) || names.set(p.name, i));
    for (const [name, order] of names) {
      const samples = runs.flatMap((run) => {
        const index = run.phases.findIndex((p) => p.name === name);
        return index < 0 ? [] : [{ run, index }];
      });
      add(base, name, order, samples);
    }
    add(base, undefined, Infinity, runs.map((run) => ({ run, index: -1 })));
  }

  entries.sort(
    (x, y) =>
      x.series.at.workload.localeCompare(y.series.at.workload) ||
      SIZES.indexOf(x.series.at.size) - SIZES.indexOf(y.series.at.size) ||
      (x.order === y.order ? 0 : x.order < y.order ? -1 : 1) ||
      x.series.at.contender.localeCompare(y.series.at.contender),
  );
  const all = entries.map((e) => e.series);
  const byKey = new Map(all.map((s) => [keyOf(s.at), s]));
  return { all, get: (at) => byKey.get(keyOf(at)) };
}

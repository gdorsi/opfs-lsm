/**
 * Pure: run records → tables. Records hold raw facts only; every ratio is
 * derived at read time, so fixing a formula re-derives old result files.
 *
 * Every per-run statistic comes from `measure` (metrics.ts): a median with its
 * min–max range over the runs. Latency percentiles pool every run's histogram.
 */
import { merge, opsOf, quantile, samplesOf } from "../core/histogram.ts";
import { DEFAULT_SEED, type HeapPeak, type RunRecord } from "../core/types.ts";
import { describe, measure, versus, type At, type Measures, type Metric, type Series } from "./metrics.ts";

type Stat = { median: number; min: number; max: number; n: number };

/** For the few cells whose field `measure` does not list: a frame count, the V8 heap sizes. */
function stat(xs: readonly number[]): Stat {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (s.length === 0) return { median: NaN, min: NaN, max: NaN, n: 0 };
  const m = s.length >> 1;
  return { median: s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2, min: s[0]!, max: s[s.length - 1]!, n: s.length };
}

type Row = { workload: string; phase: number; name: string; contender: string; runs: RunRecord[] };

function groups(records: readonly RunRecord[]): Map<string, Row[]> {
  const bySection = new Map<string, Map<string, Row>>();
  for (const r of records) {
    if (r.error) continue;
    const section = `${r.workload}\0${r.size}`;
    let rows = bySection.get(section);
    if (!rows) bySection.set(section, (rows = new Map()));
    r.phases.forEach((p, i) => {
      const key = `${i}\0${r.contender}`;
      let row = rows.get(key);
      if (!row) rows.set(key, (row = { workload: r.workload, phase: i, name: p.name, contender: r.contender, runs: [] }));
      row.runs.push(r);
    });
  }
  return new Map(
    [...bySection].map(([section, rows]) => [section, [...rows.values()].sort((a, b) => a.phase - b.phase || a.contender.localeCompare(b.contender))]),
  );
}


const fmt = (metric: Metric) => (x: number) => describe(metric).format(x, false);
const fmtN = fmt("wall");
const fmtCount = fmt("main:longTasks");
const fmtMB = fmt("amp:diskBytes");
const fmtUs = (us: number) => (!Number.isFinite(us) ? "–" : us < 10 ? "<10 µs" : us < 1000 ? `${us.toFixed(0)} µs` : `${(us / 1000).toFixed(us < 10_000 ? 2 : 1)} ms`);

const range = (r: Stat, f: (x: number) => string) => (r.n === 1 ? f(r.median) : `${f(r.median)} (${f(r.min)}–${f(r.max)})`);

/** `median (min–max)` of a series, or `empty` when the records hold none. */
function cell(s: Series | undefined, empty = "–"): string {
  return s ? range(s.summary, fmt(s.at.metric)) : empty;
}

function median(s: Series | undefined): string {
  return s ? fmt(s.at.metric)(s.summary.median) : "–";
}

/** The settled LSM layout of a row's runs, such as `L1×4`, with a run count per layout when they differ. */
function layoutCell(row: Row): string {
  const counts = new Map<string, number>();
  for (const r of row.runs) {
    const layout = r.phases[row.phase]!.footprint?.kv?.host.layout;
    if (!layout) continue;
    const key =
      layout
        .filter((l) => l.runs > 0)
        .sort((a, b) => a.level - b.level)
        .map((l) => `L${l.level}×${l.runs}`)
        .join(" ") || "empty";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (counts.size === 0) return "–";
  if (counts.size === 1) return [...counts.keys()][0]!;
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([key, n], i) => `${key} in ${n}${i === 0 ? " runs" : ""}`)
    .join(", ");
}

export function report(records: readonly RunRecord[], titles: ReadonlyMap<string, string> = new Map()): string {
  const out: string[] = [];
  const failed = records.filter((r) => r.error);
  const ok = records.find((r) => !r.error) ?? records[0];
  const measures = measure(records);
  if (ok) {
    const h = ok.host;
    out.push(`${h.chrome}${h.headless ? " headless" : ""}, ${h.os}, ${h.cpu} × ${h.cores}, node ${h.node}, git ${h.gitSha}, load ${h.loadAvg1}`);
    for (const options of measures.kvOptions) out.push(`kv opened with ${options}`);
    if (measures.seeds.some((s) => s !== DEFAULT_SEED)) out.push(`seed ${measures.seeds.join(", ")}, not the default ${DEFAULT_SEED}`);
  }
  for (const rows of groups(records).values()) {
    const first = rows[0]!.runs[0]!;
    const workload = first.workload;
    const p = first.params;
    const get = (row: Row, metric: Metric, phased = true) =>
      measures.get({ workload, size: row.runs[0]!.size, contender: row.contender, ...(phased ? { phase: row.name } : {}), metric });
    out.push("", `## ${workload}${titles.has(workload) ? `: ${titles.get(workload)}` : ""}`, "");
    if (p.keyBytes === 0) out.push(`${first.size}`);
    if (p.keyBytes > 0) out.push(
      `${first.size}: ${p.entries} entries, keys ${p.keyBytes} B, values ${p.valueBytes} B (${Math.round(p.compressibility * 100)}% compressible), batch ${p.batch}, ops ${p.ops}, raw ${fmtMB(p.entries * (p.keyBytes + p.valueBytes))} MB`,
    );
    const contenders = new Map(rows.map((r) => [r.contender, r.runs[0]!]));
    for (const [c, r] of contenders) out.push(`- ${c}: ${r.durability}; ${r.fastPath}`);
    out.push("", "| phase | contender | runs | ops/s | wall ms | op | calls | p50 | p99 | p99.9 | max |", "|---|---|---:|---:|---:|---|---:|---:|---:|---:|---:|");
    const clusterLines: string[] = [];
    for (const row of rows) {
      const phases = row.runs.map((r) => r.phases[row.phase]!);
      if (!phases[0]!.timed) continue;
      const rate = get(row, "rate");
      const wall = get(row, "wall");
      const pooled = new Map(opsOf(phases[0]!).map((op) => [op, merge(phases.flatMap((ph) => samplesOf(ph, op)))]));
      [...pooled].sort((a, b) => b[1].n - a[1].n).forEach(([op, h], i) => {
        const head = i === 0 ? `| ${row.name} | ${row.contender} | ${phases.length} | ${cell(rate)} | ${cell(wall)} ` : "| | | | | ";
        out.push(`${head}| ${op} | ${Math.round(h.n / phases.length)} | ${fmtUs(quantile(h, 0.5))} | ${fmtUs(quantile(h, 0.99))} | ${fmtUs(quantile(h, 0.999))} | ${fmtUs(h.maxUs)} |`);
      });
      const shown = rate ?? wall;
      if (shown?.summary.clusters) {
        const [lo, hi] = shown.summary.clusters;
        const f = fmt(shown.at.metric);
        const part = (c: Stat) => `${f(c.median)} (${f(c.min)}–${f(c.max)}) in ${c.n}`;
        clusterLines.push(`- ${row.name} ${row.contender}: two clusters${rate ? "" : " of wall ms"}, ${part(lo)} runs and ${part(hi)}`);
      }
    }
    if (clusterLines.length > 0) out.push("", ...clusterLines);
    const ampRows = rows.filter((row) => row.runs[0]!.phases[row.phase]!.footprint);
    if (ampRows.length > 0) {
      out.push(
        "",
        "| at | contender | W-Amp engine | W-Amp total | compaction | Read-Amp | layout | Space-Amp | user MB | WAL MB | flush MB | compact MB | disk MB | live MB |",
        "|---|---|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|",
      );
      for (const row of ampRows) {
        const approx = get(row, "amp:spaceAmp")?.approx ? "~" : "";
        const med = (metric: Metric) => median(get(row, metric));
        out.push(
          `| ${row.name} | ${row.contender} | ${med("amp:wampEngine")} | ${med("amp:wampTotal")} | ${med("amp:compaction")} | ${med("amp:readAmp")} | ${layoutCell(row)} | ${approx}${med("amp:spaceAmp")} | ${med("amp:userBytes")} | ${med("amp:walBytes")} | ${med("amp:flushBytes")} | ${med("amp:compactionBytes")} | ${approx}${med("amp:diskBytes")} | ${med("amp:liveBytes")} |`,
        );
      }
      out.push("", "`~`: from navigator.storage.estimate(), approximate. kv disk bytes are exact OPFS file sizes.");
    }
    const blockRows = rows.filter((row) => row.runs[0]!.phases[row.phase]!.mainThread);
    if (blockRows.length > 0) {
      out.push(
        "",
        "| main thread | contender | runs | long tasks | longest task ms | blocked ms | frames | frame ms | longest frame ms | dropped frames |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
      );
      for (const row of blockRows) {
        const mts = row.runs.map((r) => r.phases[row.phase]!.mainThread).filter((m) => m !== undefined);
        out.push(
          `| ${row.name} | ${row.contender} | ${mts.length} | ${median(get(row, "main:longTasks"))} | ${cell(get(row, "main:longestMs"))} | ${cell(get(row, "main:blockedMs"))} | ${fmtCount(stat(mts.map((m) => m.frames)).median)} | ${fmtN(stat(mts.map((m) => m.frameIntervalMs)).median)} | ${cell(get(row, "main:longestFrameMs"))} | ${median(get(row, "main:droppedFrames"))} |`,
        );
      }
      out.push(
        "",
        "Long tasks are main-thread tasks over 50 ms, from the `longtask` observer. Blocked ms sums each one's time past 50 ms, as Total Blocking Time does. Frames are `requestAnimationFrame` callbacks, frame ms is the display's interval, and a dropped frame is one missing from a gap between two callbacks: `round(gap / frame ms) - 1`. A block of 17 to 50 ms drops frames without being a long task.",
      );
    }
    const memRows = rows.filter((row, i) => i === rows.findIndex((r) => r.contender === row.contender) && row.runs[0]!.memory);
    if (memRows.length > 0) {
      out.push(
        "",
        "| memory peak (MB) | contender | runs | SharedWorker used | total | backing | wasm | tab used | total | backing | wasm | largest renderer |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
      );
      for (const row of memRows) {
        const mems = row.runs.map((r) => r.memory).filter((m) => m !== undefined);
        const col = (f: (m: NonNullable<(typeof mems)[number]>) => number | undefined) => {
          const st = stat(mems.map((m) => f(m) ?? NaN));
          return st.n === 0 ? "n/a" : range(st, fmtMB);
        };
        const heap = (pick: (m: NonNullable<(typeof mems)[number]>) => HeapPeak | null, field: keyof HeapPeak) =>
          col((m) => pick(m)?.[field]);
        out.push(
          `| | ${row.contender} | ${mems.length} | ${heap((m) => m.sharedWorker, "usedSize")} | ${heap((m) => m.sharedWorker, "totalSize")} | ${heap((m) => m.sharedWorker, "backingStorageSize")} | ${col((m) => m.sharedWorkerWasmBytes ?? undefined)} | ${heap((m) => m.tab, "usedSize")} | ${heap((m) => m.tab, "totalSize")} | ${heap((m) => m.tab, "backingStorageSize")} | ${col((m) => m.tabWasmBytes ?? undefined)} | ${cell(get(row, "mem:largestRenderer", false), "n/a")} |`,
        );
      }
      out.push("", "Sampled every 100 ms with `Runtime.getHeapUsage`, so a peak shorter than that can be missed. `n/a`: Chrome did not report the counter. Largest renderer is the biggest single renderer process: on macOS `phys_footprint_peak`, the kernel's own peak, read before each tab closes and at the end of the run; elsewhere the largest RSS seen, read once a second.");
    }
  }
  if (failed.length > 0) {
    out.push("", "## Failed runs", "");
    for (const r of failed) out.push(`- ${r.workload} ${r.contender} rep ${r.rep}: ${r.error?.split("\n")[0]}`);
  }
  return out.join("\n");
}

function verdict(v: ReturnType<typeof versus>, ratio: boolean): string {
  if (!v.distinct) return "≈";
  const better = v.times > 1;
  const times = better ? v.times : 1 / v.times;
  return `B ${better ? "better" : "worse"}${ratio && Number.isFinite(times) ? ` ×${times.toFixed(2)}` : ""}`;
}

function sideCell(s: Series): string {
  const { format } = describe(s.at.metric);
  const { n, median, min, max, clusters } = s.summary;
  return `${n === 1 ? format(median) : `${format(median)} (${format(min, false)}–${format(max, false)})`}${clusters ? " †" : ""}`;
}

/**
 * Every series both measures hold, with the verdict of B against A by the
 * min–max ranges and the metric's direction. Without `all` only the series
 * with a measurable difference are listed.
 */
export function compare(a: Measures, b: Measures, { all = false }: { all?: boolean } = {}): string {
  const rows: string[] = [];
  const only = { A: new Map<string, number>(), B: new Map<string, number>() };
  const count = (side: "A" | "B", at: At) => {
    const key = [at.workload, at.size, at.phase ?? "run", at.contender].join(" ");
    only[side].set(key, (only[side].get(key) ?? 0) + 1);
  };
  let compared = 0;
  let same = 0;
  let marked = false;
  for (const sa of a.all) {
    const sb = b.get(sa.at);
    if (!sb) {
      count("A", sa.at);
      continue;
    }
    compared++;
    const v = versus(sa, sb);
    if (!v.distinct) same++;
    if (!all && !v.distinct) continue;
    marked ||= !!sa.summary.clusters || !!sb.summary.clusters;
    const at = sa.at;
    rows.push(`| ${at.workload} | ${at.size} | ${at.phase ?? "–"} | ${at.contender} | ${at.metric} | ${sideCell(sa)} | ${sideCell(sb)} | ${verdict(v, describe(at.metric).ratio)} |`);
  }
  for (const sb of b.all) if (!a.get(sb.at)) count("B", sb.at);

  const out: string[] = [];
  for (const [side, m] of [["A", a], ["B", b]] as const) {
    for (const options of m.kvOptions) out.push(`${side} opened kv with ${options}`);
  }
  const seeds = (m: Measures) => m.seeds.join(", ") || "–";
  if (seeds(a) !== seeds(b)) out.push(`A ran on seed ${seeds(a)} and B on seed ${seeds(b)}, so this compares two inputs, not a before and after`);
  if (out.length > 0) out.push("");
  if (rows.length > 0) {
    out.push("| workload | size | phase | contender | metric | A | B | verdict |", "|---|---|---|---|---|---:|---:|---|", ...rows);
  }
  out.push("", `${compared} series compared, ${same} with no measurable difference`);
  if (marked) out.push("", "`†`: this side's runs form two clusters, so its median and range hide two states. `report` prints both.");
  for (const [name, map] of Object.entries(only)) {
    if (map.size > 0) out.push("", `Only in ${name}:`, ...[...map].map(([key, n]) => `- ${key} (${n} series)`));
  }
  return out.join("\n");
}

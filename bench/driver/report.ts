/**
 * Pure: run records → tables. Records hold raw facts only; every ratio is
 * derived here, so fixing a formula re-derives old result files.
 *
 * Throughput is the median of per-run ops/s with the min–max range.
 * Latency percentiles pool every run's histogram. Amplification follows
 * docs/research/benchmark-prior-art.md section 2.2:
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
import type { IoCounters, KvStats } from "@opfs-lsm/kv/testing";
import { merge, quantile } from "../core/histogram.ts";
import type { HeapPeak, PhaseResult, RunRecord } from "../core/types.ts";

type Stat = { median: number; min: number; max: number; n: number };

function stat(xs: readonly number[]): Stat {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (s.length === 0) return { median: NaN, min: NaN, max: NaN, n: 0 };
  const m = s.length >> 1;
  return { median: s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2, min: s[0]!, max: s[s.length - 1]!, n: s.length };
}

function opsOf(p: PhaseResult): number {
  return p.ops;
}

/** Ops per second over the phase's wall time minus the store open, which is reported on its own. */
function rate(p: PhaseResult): number {
  return (p.ops / (p.wallMs - (p.latency.open?.sumUs ?? 0) / 1000)) * 1000;
}

function sumClass(c: IoCounters["written"], pred: (cls: string) => boolean): number {
  return Object.entries(c).reduce((t, [cls, v]) => (pred(cls) ? t + v.bytes : t), 0);
}

const isLevel = (n: number) => (cls: string) => cls === `l${n}`;
const isDeeper = (cls: string) => /^l[1-9]\d*$/.test(cls);

export type Amp = {
  userIn: number;
  wal: number;
  flush: number;
  compaction: number;
  manifest: number;
  disk: number;
  live: number;
  wampEngine: number;
  wampTotal: number;
  compactionRatio: number;
  readAmp: number;
  spaceAmp: number;
  spaceExact: boolean;
};

export function amplification(record: RunRecord, phaseIndex: number): Amp | undefined {
  const p = record.phases[phaseIndex];
  const fp = p?.footprint;
  if (!p || !fp) return undefined;
  // user bytes of every phase on the same page, up to and including this one
  let userIn = 0;
  for (let i = phaseIndex; i >= 0; i--) {
    const q = record.phases[i]!;
    userIn += q.userBytes;
    if (q.page === "fresh") break;
  }
  const kv: KvStats | undefined = fp.kv;
  if (!kv) {
    const disk = fp.idbEstimateBytes + fp.opfsBytes;
    return {
      userIn, wal: NaN, flush: NaN, compaction: NaN, manifest: NaN, disk, live: fp.liveLogicalBytes,
      wampEngine: NaN, wampTotal: NaN, compactionRatio: NaN, readAmp: NaN,
      spaceAmp: disk / fp.liveLogicalBytes, spaceExact: false,
    };
  }
  const w = kv.host.fs.written;
  const flush = sumClass(w, isLevel(0));
  const compaction = sumClass(w, isDeeper);
  const manifest = sumClass(w, (c) => c === "m");
  const wal = kv.tab.walBytes;
  const l0 = kv.host.layout.find((l) => l.level === 0)?.runs ?? 0;
  const deeper = kv.host.layout.filter((l) => l.level > 0 && l.runs > 0).length;
  return {
    userIn, wal, flush, compaction, manifest, disk: fp.opfsBytes, live: fp.liveLogicalBytes,
    wampEngine: (flush + compaction) / userIn,
    wampTotal: (wal + flush + compaction + manifest) / userIn,
    compactionRatio: compaction / flush,
    readAmp: l0 + deeper,
    spaceAmp: fp.opfsBytes / fp.liveLogicalBytes,
    spaceExact: true,
  };
}

type Row = { workload: string; phase: number; name: string; contender: string; runs: RunRecord[] };

function groups(records: readonly RunRecord[]): Map<string, Row[]> {
  const byWorkload = new Map<string, Map<string, Row>>();
  for (const r of records) {
    if (r.error) continue;
    let rows = byWorkload.get(r.workload);
    if (!rows) byWorkload.set(r.workload, (rows = new Map()));
    r.phases.forEach((p, i) => {
      const key = `${i}\0${r.contender}`;
      let row = rows.get(key);
      if (!row) rows.set(key, (row = { workload: r.workload, phase: i, name: p.name, contender: r.contender, runs: [] }));
      row.runs.push(r);
    });
  }
  return new Map(
    [...byWorkload].map(([w, rows]) => [w, [...rows.values()].sort((a, b) => a.phase - b.phase || a.contender.localeCompare(b.contender))]),
  );
}

const COUNTER_ORDER = ["keys", "storage ops", "storage ops per key"];
const rankCounter = (name: string) => {
  const i = COUNTER_ORDER.indexOf(name);
  return i < 0 ? COUNTER_ORDER.length : i;
};

const fmtN = (x: number) =>
  !Number.isFinite(x) ? "–" : x >= 100_000 ? `${(x / 1000).toFixed(0)}k` : x >= 10_000 ? `${(x / 1000).toFixed(1)}k` : x >= 100 ? x.toFixed(0) : x.toFixed(1);
const ms2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "–");
const fmtCount = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
const fmtRange = (s: Stat) => (s.n === 0 ? "–" : s.n === 1 ? fmtN(s.median) : `${fmtN(s.median)} (${fmtN(s.min)}–${fmtN(s.max)})`);
const fmtUs = (us: number) => (!Number.isFinite(us) ? "–" : us < 10 ? "<10 µs" : us < 1000 ? `${us.toFixed(0)} µs` : `${(us / 1000).toFixed(us < 10_000 ? 2 : 1)} ms`);
const fmtX = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "–");
const fmtMB = (b: number) => (Number.isFinite(b) ? (b / 1e6).toFixed(1) : "–");

export function report(records: readonly RunRecord[], titles: ReadonlyMap<string, string> = new Map()): string {
  const out: string[] = [];
  const failed = records.filter((r) => r.error);
  const ok = records.find((r) => !r.error) ?? records[0];
  if (ok) {
    const h = ok.host;
    out.push(`${h.chrome}${h.headless ? " headless" : ""}, ${h.os}, ${h.cpu} × ${h.cores}, node ${h.node}, git ${h.gitSha}, load ${h.loadAvg1}`);
  }
  for (const [workload, rows] of groups(records)) {
    const first = rows[0]!.runs[0]!;
    const p = first.params;
    out.push("", `## ${workload}${titles.has(workload) ? `: ${titles.get(workload)}` : ""}`, "");
    if (p.keyBytes === 0) out.push(`${first.size}`);
    if (p.keyBytes > 0) out.push(
      `${first.size}: ${p.entries} entries, keys ${p.keyBytes} B, values ${p.valueBytes} B (${Math.round(p.compressibility * 100)}% compressible), batch ${p.batch}, ops ${p.ops}, raw ${fmtMB(p.entries * (p.keyBytes + p.valueBytes))} MB`,
    );
    const contenders = new Map(rows.map((r) => [r.contender, r.runs[0]!]));
    for (const [c, r] of contenders) out.push(`- ${c}: ${r.durability}; ${r.fastPath}`);
    out.push("", "| phase | contender | runs | ops/s | wall ms | op | calls | p50 | p99 | p99.9 | max |", "|---|---|---:|---:|---:|---|---:|---:|---:|---:|---:|");
    for (const row of rows) {
      const phases = row.runs.map((r) => r.phases[row.phase]!);
      if (!phases[0]!.timed) continue;
      const opsPerSec = stat(phases.map(rate));
      const wall = stat(phases.map((ph) => ph.wallMs));
      const opNames = Object.keys(phases[0]!.latency).sort(
        (a, b) => (phases[0]!.latency[b]?.n ?? 0) - (phases[0]!.latency[a]?.n ?? 0),
      );
      opNames.forEach((op, i) => {
        const h = merge(phases.map((ph) => ph.latency[op]).filter((x) => x !== undefined));
        const head = i === 0 ? `| ${row.name} | ${row.contender} | ${phases.length} | ${opsOf(phases[0]!) > 0 ? fmtRange(opsPerSec) : "–"} | ${fmtRange(wall)} ` : "| | | | | ";
        out.push(`${head}| ${op} | ${Math.round(h.n / phases.length)} | ${fmtUs(quantile(h, 0.5))} | ${fmtUs(quantile(h, 0.99))} | ${fmtUs(quantile(h, 0.999))} | ${fmtUs(h.maxUs)} |`);
      });
    }
    const ampRows = rows.filter((row) => row.runs[0]!.phases[row.phase]!.footprint);
    if (ampRows.length > 0) {
      out.push(
        "",
        "| at | contender | W-Amp engine | W-Amp total | compaction | Read-Amp | Space-Amp | user MB | WAL MB | flush MB | compact MB | disk MB | live MB |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
      );
      for (const row of ampRows) {
        const amps = row.runs.map((r) => amplification(r, row.phase)).filter((a): a is Amp => a !== undefined);
        const med = (f: (a: Amp) => number) => stat(amps.map(f)).median;
        const exact = amps[0]?.spaceExact ?? true;
        out.push(
          `| ${row.name} | ${row.contender} | ${fmtX(med((a) => a.wampEngine))} | ${fmtX(med((a) => a.wampTotal))} | ${fmtX(med((a) => a.compactionRatio))} | ${fmtN(med((a) => a.readAmp))} | ${exact ? "" : "~"}${fmtX(med((a) => a.spaceAmp))} | ${fmtMB(med((a) => a.userIn))} | ${fmtMB(med((a) => a.wal))} | ${fmtMB(med((a) => a.flush))} | ${fmtMB(med((a) => a.compaction))} | ${exact ? "" : "~"}${fmtMB(med((a) => a.disk))} | ${fmtMB(med((a) => a.live))} |`,
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
          `| ${row.name} | ${row.contender} | ${mts.length} | ${fmtCount(stat(mts.map((m) => m.longTasks)).median)} | ${fmtRange(stat(mts.map((m) => m.longestMs)))} | ${fmtRange(stat(mts.map((m) => m.blockedMs)))} | ${fmtCount(stat(mts.map((m) => m.frames)).median)} | ${fmtN(stat(mts.map((m) => m.frameIntervalMs)).median)} | ${fmtRange(stat(mts.map((m) => m.longestFrameMs)))} | ${fmtCount(stat(mts.map((m) => m.droppedFrames)).median)} |`,
        );
      }
      out.push(
        "",
        "Long tasks are main-thread tasks over 50 ms, from the `longtask` observer. Blocked ms sums each one's time past 50 ms, as Total Blocking Time does. Frames are `requestAnimationFrame` callbacks, frame ms is the display's interval, and a dropped frame is one missing from a gap between two callbacks: `round(gap / frame ms) - 1`. A block of 17 to 50 ms drops frames without being a long task.",
      );
    }
    const counterRows = rows.filter((row) => row.runs[0]!.phases[row.phase]!.counters);
    if (counterRows.length > 0) {
      const names = [...new Set(counterRows.flatMap((row) => Object.keys(row.runs[0]!.phases[row.phase]!.counters ?? {})))].sort(
        (a, b) => rankCounter(a) - rankCounter(b) || a.localeCompare(b),
      );
      out.push("", `| counters (median) | contender | ${names.join(" | ")} |`, `|---|---|${names.map(() => "---:").join("|")}|`);
      for (const row of counterRows) {
        const cells = names.map((n) => {
          const st = stat(row.runs.map((r) => r.phases[row.phase]!.counters?.[n] ?? NaN));
          return st.n === 0 ? "–" : fmtN(st.median);
        });
        out.push(`| ${row.name} | ${row.contender} | ${cells.join(" | ")} |`);
      }
    }
    const floor = rows.find((row) => row.contender.endsWith("/memory"));
    if (floor) {
      const lines: string[] = [];
      for (const row of rows) {
        if (row.contender === floor.contender) continue;
        const base = rows.find((r) => r.phase === row.phase && r.contender === floor.contender);
        if (!base || !row.runs[0]!.phases[row.phase]!.timed) continue;
        const mean = (r: Row, op: string) => {
          const h = merge(r.runs.map((x) => x.phases[r.phase]!.latency[op]).filter((x) => x !== undefined));
          return h.n === 0 ? NaN : h.sumUs / h.n / 1000;
        };
        for (const op of Object.keys(row.runs[0]!.phases[row.phase]!.latency)) {
          if (op === "open") continue;
          const [a, b] = [mean(row, op), mean(base, op)];
          lines.push(`| ${row.name} | ${op} | ${row.contender} | ${ms2(a)} | ${ms2(b)} | ${ms2(a - b)} |`);
        }
      }
      if (lines.length > 0) {
        out.push(
          "",
          `| storage cost (mean ms per call) | op | contender | contender ms | ${floor.contender} ms | difference ms |`,
          "|---|---|---|---:|---:|---:|",
          ...lines,
          "",
          `${floor.contender} keeps both layers in Maps, so the difference is what the contender's storage adds to the same model, Automerge and fate work.`,
        );
      }
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
          return st.n === 0 ? "n/a" : st.n === 1 ? fmtMB(st.median) : `${fmtMB(st.median)} (${fmtMB(st.min)}–${fmtMB(st.max)})`;
        };
        const heap = (pick: (m: NonNullable<(typeof mems)[number]>) => HeapPeak | null, field: keyof HeapPeak) =>
          col((m) => pick(m)?.[field]);
        out.push(
          `| | ${row.contender} | ${mems.length} | ${heap((m) => m.sharedWorker, "usedSize")} | ${heap((m) => m.sharedWorker, "totalSize")} | ${heap((m) => m.sharedWorker, "backingStorageSize")} | ${col((m) => m.sharedWorkerWasmBytes ?? undefined)} | ${heap((m) => m.tab, "usedSize")} | ${heap((m) => m.tab, "totalSize")} | ${heap((m) => m.tab, "backingStorageSize")} | ${col((m) => m.tabWasmBytes ?? undefined)} | ${col((m) => m.largestRendererBytes ?? undefined)} |`,
        );
      }
      out.push("", "Sampled every 100 ms with `Runtime.getHeapUsage`, so a peak shorter than that can be missed. `n/a`: Chrome did not report the counter. Largest renderer is the biggest single renderer process, read once a second: `phys_footprint_peak` on macOS, the kernel's own peak; elsewhere the largest RSS seen.");
    }
  }
  if (failed.length > 0) {
    out.push("", "## Failed runs", "");
    for (const r of failed) out.push(`- ${r.workload} ${r.contender} rep ${r.rep}: ${r.error?.split("\n")[0]}`);
  }
  return out.join("\n");
}

/** Faster / slower / no measurable difference, by min–max overlap of per-run ops/s. */
export function compare(a: readonly RunRecord[], b: readonly RunRecord[]): string {
  const ga = groups(a);
  const gb = groups(b);
  const out = ["| workload | phase | contender | A ops/s | B ops/s | verdict |", "|---|---|---|---:|---:|---|"];
  for (const [workload, rowsA] of ga) {
    for (const ra of rowsA) {
      const rb = gb.get(workload)?.find((r) => r.phase === ra.phase && r.contender === ra.contender);
      if (!rb || !ra.runs[0]!.phases[ra.phase]!.timed) continue;
      const sa = stat(ra.runs.map((r) => rate(r.phases[ra.phase]!)));
      const sb = stat(rb.runs.map((r) => rate(r.phases[rb.phase]!)));
      const verdict =
        sb.min > sa.max ? `B faster ×${fmtX(sb.median / sa.median)}` : sb.max < sa.min ? `B slower ×${fmtX(sa.median / sb.median)}` : "≈ no measurable difference";
      out.push(`| ${workload} | ${ra.name} | ${ra.contender} | ${fmtRange(sa)} | ${fmtRange(sb)} | ${verdict} |`);
    }
  }
  return out.join("\n");
}

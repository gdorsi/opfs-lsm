/**
 * node bench/cli.ts <verb> [args]
 *
 *   run [workload…] [--size tiny|small|large] [--reps N] [--contenders a,b] [--headed]
 *       [--max-peak-bytes N] [--compaction-memory-bytes N] [--cache-bytes N]
 *   smoke [--check]         every workload × contender, size tiny, 1 rep, correctness and the byte budgets;
 *                           --check first applies the bundle-size budgets to the same build,
 *                           then checks that every access pattern has exactly one owner,
 *                           and also runs the byte-budget rows above size tiny
 *   size [--check]          bundle-size table; --check fails over a row's budget
 *   compare <a.jsonl> <b.jsonl> [--all]
 *                           every metric both files hold, B against A by the min–max ranges;
 *                           --all also lists the rows with no measurable difference
 *   report <file.jsonl>
 *
 * A workload selector is "kv/" (a family) or "kv/fillrandom" (one workload).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { ownershipProblems, PATTERNS } from "./core/patterns.ts";
import { SIZES, type KvOptions, type RunRecord, type SizeName } from "./core/types.ts";
import { BENCH_DIR, buildBench, type BuildOutput } from "./driver/build.ts";
import { BUDGETS, budgetProblems } from "./driver/budgets.ts";
import { DATA_DIR, ensureTrace } from "./driver/data.ts";
import { plan, type PlannedRun } from "./driver/plan.ts";
import { measure } from "./driver/metrics.ts";
import { compare, report } from "./driver/report.ts";
import { readCatalog, runPlan } from "./driver/run.ts";
import { serve } from "./driver/serve.ts";
import { formatSizes, measureSizes } from "./driver/size.ts";

const RESULTS_DIR = path.join(BENCH_DIR, "results");

async function main(): Promise<number> {
  const [verb, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      size: { type: "string", default: "small" },
      reps: { type: "string", default: "5" },
      contenders: { type: "string", default: "" },
      headed: { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      timeout: { type: "string", default: "1800000" },
      "max-peak-bytes": { type: "string", default: "" },
      "compaction-memory-bytes": { type: "string", default: "" },
      "cache-bytes": { type: "string", default: "" },
    },
  });
  switch (verb) {
    case "run":
    case "smoke": {
      const smoke = verb === "smoke";
      const size = (smoke ? "tiny" : values.size) as SizeName;
      if (!SIZES.includes(size)) throw new Error(`--size must be one of ${SIZES.join(", ")}`);
      return run({
        workloads: smoke ? [] : positionals,
        contenders: values.contenders ? values.contenders.split(",") : [],
        size,
        reps: smoke ? 1 : Number(values.reps),
        headless: !values.headed,
        timeoutMs: Number(values.timeout),
        smoke,
        check: smoke && values.check,
        maxPeakBytes: bytesFlag("maxPeakBytes", "max-peak-bytes", values["max-peak-bytes"]).maxPeakBytes,
        kv: {
          ...bytesFlag("compactionMemoryBytes", "compaction-memory-bytes", values["compaction-memory-bytes"]),
          ...bytesFlag("cacheBytes", "cache-bytes", values["cache-bytes"]),
        },
      });
    }
    case "size":
      return sizes(await buildBench({ quiet: true }), values.check) ? 0 : 1;
    case "compare": {
      const [a, b] = positionals;
      if (!a || !b) throw new Error("compare needs two result files");
      console.log(compare(measure(readRecords(a)), measure(readRecords(b)), { all: values.all }));
      return 0;
    }
    case "report": {
      const [file] = positionals;
      if (!file) throw new Error("report needs a result file");
      console.log(report(readRecords(file)));
      return 0;
    }
    default:
      console.error(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0]);
      return 1;
  }
}

async function run(o: {
  workloads: string[];
  contenders: string[];
  size: SizeName;
  reps: number;
  headless: boolean;
  timeoutMs: number;
  smoke: boolean;
  check: boolean;
  maxPeakBytes: number | undefined;
  kv: KvOptions;
}): Promise<number> {
  await ensureTrace();
  const built = await buildBench({ quiet: true });
  if (o.check && !sizes(built, true)) return 1;
  const server = await serve({ "/": path.join(BENCH_DIR, ".out"), "/data/": DATA_DIR });
  try {
    const catalog = await readCatalog(server.origin, o.headless);
    if (o.check && !owners(catalog)) return 1;
    const runs = plan(catalog, { workloads: o.workloads, contenders: o.contenders, size: o.size, reps: o.reps });
    if (o.check) runs.push(...budgetRuns(catalog, o.size));
    mkdirSync(RESULTS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    // Named by CPU, not hostname: published runs are committed under docs/results/.
    const cpu = (os.cpus()[0]?.model ?? "cpu").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const resultsFile = path.join(RESULTS_DIR, `${stamp}-${cpu}${o.smoke ? "-smoke" : ""}.jsonl`);
    console.log(`${runs.length} runs → ${path.relative(process.cwd(), resultsFile)}`);
    const records = await runPlan(runs, {
      origin: server.origin,
      headless: o.headless,
      resultsFile,
      phaseTimeoutMs: o.timeoutMs,
      kv: o.kv,
      log: (line) => console.log(line),
    });
    const text = report(records, new Map(catalog.map((w) => [w.workload, w.title])));
    writeFileSync(resultsFile.replace(/\.jsonl$/, ".md"), text + "\n");
    console.log("\n" + text);
    const problems = records.filter((r) => r.error).map((r) => `${r.workload} ${r.contender}: ${r.error}`);
    problems.push(...budgetProblems(measure(records)));
    if (o.smoke) problems.push(...smokeChecks(records));
    if (o.maxPeakBytes !== undefined) problems.push(...peakChecks(records, o.maxPeakBytes));
    if (problems.length > 0) {
      console.error(`\n${problems.length} problem(s):\n${problems.join("\n")}`);
      return 1;
    }
    return 0;
  } finally {
    await server.close();
  }
}

/** Print the bundle-size table of a build. With `check`, false when a row is over its budget. */
/** `{ [key]: bytes }` when the flag is set, `{}` when it is not. */
function bytesFlag<K extends string>(key: K, flag: string, value: string | undefined): { [P in K]?: number } {
  if (!value) return {};
  const bytes = Number(value);
  if (!(bytes > 0)) throw new Error(`--${flag} must be a positive number of bytes`);
  return { [key]: bytes } as { [P in K]?: number };
}

function sizes(built: BuildOutput, check: boolean): boolean {
  const rows = measureSizes(built);
  console.log(formatSizes(rows));
  const over = rows.filter((r) => r.budget !== undefined && r.afterOpen.brotli > r.budget);
  if (!check || over.length === 0) return true;
  console.error(`over budget: ${over.map((r) => `${r.id} ${r.afterOpen.brotli} > ${r.budget}`).join(", ")}`);
  return false;
}

/** Every access pattern in bench/core/patterns.ts has exactly one owner among the workloads. */
function owners(catalog: Awaited<ReturnType<typeof readCatalog>>): boolean {
  const problems = ownershipProblems(catalog);
  if (problems.length === 0) {
    console.log(`${Object.keys(PATTERNS).length} access patterns, one owner each`);
    return true;
  }
  console.error(`access patterns (bench/core/patterns.ts):\n${problems.join("\n")}`);
  return false;
}

/** One run of each budget row above the size the smoke already runs. */
function budgetRuns(catalog: Awaited<ReturnType<typeof readCatalog>>, ran: SizeName): PlannedRun[] {
  const rows = new Map(BUDGETS.filter((b) => b.size !== ran).map((b) => [`${b.workload} ${b.contender} ${b.size}`, b]));
  return [...rows.values()].flatMap((b) => plan(catalog, { workloads: [b.workload], contenders: [b.contender], size: b.size, reps: 1 }));
}

/** Harness health: a kv footprint after writes must show counted WAL bytes. */
function smokeChecks(records: readonly RunRecord[]): string[] {
  const m = measure(records);
  const problems: string[] = [];
  for (const wal of m.all) {
    if (wal.at.metric !== "amp:walBytes") continue;
    const user = m.get({ ...wal.at, metric: "amp:userBytes" });
    if (user && user.summary.min > 0 && !(wal.summary.min > 0)) {
      problems.push(`${wal.at.workload} ${wal.at.contender} ${wal.at.phase}: user bytes but no WAL bytes counted`);
    }
  }
  return problems;
}

/** Opt-in ceiling on the SharedWorker's peak: the sum of three peaks (an upper bound): JS heap in use, ArrayBuffer backing store, wasm memory. Chrome's backing counter does not include wasm memory (bench/probes/memory.ts). */
function peakChecks(records: readonly RunRecord[], maxBytes: number): string[] {
  return measure(records)
    .all.filter((s) => s.at.metric === "mem:sharedWorkerTotal" && s.summary.max > maxBytes)
    .map((s) => `${s.at.workload} ${s.at.contender}: SharedWorker peak ${s.summary.max} B > --max-peak-bytes ${maxBytes}`);
}

function readRecords(file: string): RunRecord[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RunRecord);
}

process.exitCode = await main().catch((e: unknown) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  return 1;
});

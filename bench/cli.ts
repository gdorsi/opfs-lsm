/**
 * node bench/cli.ts <verb> [args]
 *
 *   run [workload…] [--size tiny|small|large] [--reps N] [--contenders a,b] [--headed] [--seed N]
 *       [--max-peak-bytes N] [--compaction-memory-bytes N] [--cache-bytes N]
 *   smoke [--check] [--seed N]
 *                           every workload × contender, size tiny, 1 rep, correctness and the byte budgets;
 *                           --check first applies the bundle-size budgets to the size rows' build,
 *                           then checks that every access pattern has exactly one owner,
 *                           and also runs the byte-budget rows above size tiny
 *   size [--check]          bundle-size table; --check fails over a row's budget
 *   compare <a.jsonl> <b.jsonl> [--all]
 *                           every metric both files hold, B against A by a rank-sum test of the runs;
 *                           --all also lists the rows with no measurable difference
 *   report <file.jsonl>
 *   docs [--check]          rewrite the tables of docs/benchmarks.md from the runs under docs/results/;
 *                           --check fails when the page differs, and needs no Chrome or build
 *
 * A workload selector is "kv/" (a family) or "kv/fillrandom" (one workload).
 * --seed (default 1) seeds every op stream, history and curated binding; the
 * byte budgets hold for the default seed only.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { ownershipProblems, PATTERNS } from "./core/patterns.ts";
import { DEFAULT_SEED, SIZES, type KvOptions, type RunRecord, type SizeName } from "./core/types.ts";
import { TABLES } from "./docs-tables.ts";
import { BENCH_DIR, buildBench, type BuildOutput } from "./driver/build.ts";
import { BUDGETS, budgetProblems } from "./driver/budgets.ts";
import { DATA_DIR, ensureTrace } from "./driver/data.ts";
import { PAGE, readPublished, renderDocs, staleTables } from "./driver/docs.ts";
import { plan, type PlannedRun } from "./driver/plan.ts";
import { measure } from "./driver/metrics.ts";
import { compare, report } from "./driver/report.ts";
import { readRecords } from "./driver/records.ts";
import { readCatalog, runPlan } from "./driver/run.ts";
import { serve } from "./driver/serve.ts";
import { formatSizes, measureSizes, overBudget } from "./driver/size.ts";

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
      seed: { type: "string", default: String(DEFAULT_SEED) },
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
        seed: seedFlag(values.seed),
        headless: !values.headed,
        timeoutMs: Number(values.timeout),
        smoke,
        check: smoke && values.check,
        maxPeakBytes: bytesFlag("maxPeakBytes", "max-peak-bytes", values["max-peak-bytes"]).maxPeakBytes,
        kv: {
          ...bytesFlag("compactionMemoryBytes", "compaction-memory-bytes", values["compaction-memory-bytes"], KV_MIN_BYTES.compactionMemoryBytes),
          ...bytesFlag("cacheBytes", "cache-bytes", values["cache-bytes"], KV_MIN_BYTES.cacheBytes),
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
    case "docs":
      return docs(values.check);
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
  seed: number;
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
    const runs = plan(catalog, { workloads: o.workloads, contenders: o.contenders, size: o.size, reps: o.reps, seed: o.seed });
    if (o.check && o.seed === DEFAULT_SEED) runs.push(...budgetRuns(catalog, o.size));
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
    const measured = measure(records);
    if (measured.kvOptions.length > 0) console.log(`\nThe byte budgets were not checked: kv opened with ${measured.kvOptions.join(", and with ")}.`);
    else if (measured.seeds.some((s) => s !== DEFAULT_SEED)) console.log(`\nThe byte budgets were not checked: they hold for seed ${DEFAULT_SEED}, and the runs used seed ${measured.seeds.join(", ")}.`);
    problems.push(...budgetProblems(measured));
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

/** kv raises a smaller figure to these, so a record of less would name an option the run did not have. */
const KV_MIN_BYTES: Required<KvOptions> = { compactionMemoryBytes: 8 * 1024 * 1024, cacheBytes: 1024 * 1024 };

function seedFlag(value: string): number {
  const seed = Number(value);
  if (!/^\d+$/.test(value) || seed > 0xffff_ffff) throw new Error(`--seed must be a whole number from 0 to ${0xffff_ffff}`);
  return seed;
}

/** `{ [key]: bytes }` when the flag is set, `{}` when it is not. */
function bytesFlag<K extends string>(key: K, flag: string, value: string | undefined, min = 1): { [P in K]?: number } {
  if (!value) return {};
  const bytes = Number(value);
  if (!Number.isInteger(bytes) || bytes < min) throw new Error(`--${flag} must be a whole number of bytes, at least ${min}`);
  return { [key]: bytes } as { [P in K]?: number };
}

/** Print the bundle-size table of a build. With `check`, false when a row is over its budget. */
function sizes(built: BuildOutput, check: boolean): boolean {
  const rows = measureSizes(built);
  console.log(formatSizes(rows));
  const over = overBudget(rows);
  if (!check || over.length === 0) return true;
  console.error(`over budget: ${over.join(", ")}`);
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

/** One run of each budget row above the size the smoke already runs, on the seed the budgets hold for. */
function budgetRuns(catalog: Awaited<ReturnType<typeof readCatalog>>, ran: SizeName): PlannedRun[] {
  const rows = new Map(BUDGETS.filter((b) => b.size !== ran).map((b) => [`${b.workload} ${b.contender} ${b.size}`, b]));
  return [...rows.values()].flatMap((b) => plan(catalog, { workloads: [b.workload], contenders: [b.contender], size: b.size, reps: 1, seed: DEFAULT_SEED }));
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

/** Write the generated tables into docs/benchmarks.md. With `check`, only say which tables differ. */
function docs(check: boolean): number {
  const page = readFileSync(PAGE, "utf8");
  const stale = staleTables(page, TABLES, readPublished);
  if (check) {
    if (stale.length === 0) return 0;
    console.error(`docs/benchmarks.md differs from the runs in docs/results/ in: ${stale.join(", ")}.\nRun \`node bench/cli.ts docs\` and commit the page.`);
    return 1;
  }
  if (stale.length > 0) writeFileSync(PAGE, renderDocs(page, TABLES, readPublished));
  console.log(stale.length === 0 ? "docs/benchmarks.md: every table is current" : `docs/benchmarks.md: rewrote ${stale.join(", ")}`);
  return 0;
}

process.exitCode = await main().catch((e: unknown) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  return 1;
});

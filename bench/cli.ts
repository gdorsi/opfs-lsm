/**
 * node bench/cli.ts <verb> [args]
 *
 *   run [workload…] [--size tiny|small|large] [--reps N] [--contenders a,b] [--headed] [--max-peak-bytes N]
 *   smoke                   every workload × contender, size tiny, 1 rep, correctness only
 *   size [--check]          bundle-size table; --check fails over a row's budget
 *   compare <a.jsonl> <b.jsonl>
 *   report <file.jsonl>
 *
 * A workload selector is "kv/" (a family) or "kv/fillrandom" (one workload).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { SIZES, type RunRecord, type SizeName } from "./core/types.ts";
import { BENCH_DIR, buildBench } from "./driver/build.ts";
import { DATA_DIR, ensureTrace } from "./driver/data.ts";
import { plan } from "./driver/plan.ts";
import { amplification, compare, report } from "./driver/report.ts";
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
      timeout: { type: "string", default: "1800000" },
      "max-peak-bytes": { type: "string", default: "" },
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
        maxPeakBytes: values["max-peak-bytes"] ? Number(values["max-peak-bytes"]) : undefined,
      });
    }
    case "size": {
      const rows = measureSizes(await buildBench({ quiet: true }));
      console.log(formatSizes(rows));
      const over = rows.filter((r) => r.budget !== undefined && r.afterOpen.brotli > r.budget);
      if (values.check && over.length > 0) {
        console.error(`over budget: ${over.map((r) => `${r.id} ${r.afterOpen.brotli} > ${r.budget}`).join(", ")}`);
        return 1;
      }
      return 0;
    }
    case "compare": {
      const [a, b] = positionals;
      if (!a || !b) throw new Error("compare needs two result files");
      console.log(compare(readRecords(a), readRecords(b)));
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
  maxPeakBytes: number | undefined;
}): Promise<number> {
  await ensureTrace();
  await buildBench({ quiet: true });
  const server = await serve({ "/": path.join(BENCH_DIR, ".out"), "/data/": DATA_DIR });
  try {
    const catalog = await readCatalog(server.origin, o.headless);
    const runs = plan(catalog, { workloads: o.workloads, contenders: o.contenders, size: o.size, reps: o.reps });
    mkdirSync(RESULTS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const resultsFile = path.join(RESULTS_DIR, `${stamp}-${os.hostname().split(".")[0]}${o.smoke ? "-smoke" : ""}.jsonl`);
    console.log(`${runs.length} runs → ${path.relative(process.cwd(), resultsFile)}`);
    const records = await runPlan(runs, {
      origin: server.origin,
      headless: o.headless,
      resultsFile,
      phaseTimeoutMs: o.timeoutMs,
      log: (line) => console.log(line),
    });
    const text = report(records, new Map(catalog.map((w) => [w.workload, w.title])));
    writeFileSync(resultsFile.replace(/\.jsonl$/, ".md"), text + "\n");
    console.log("\n" + text);
    const problems = records.filter((r) => r.error).map((r) => `${r.workload} ${r.contender}: ${r.error}`);
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

/** Harness health: a kv footprint after writes must show counted log bytes. */
function smokeChecks(records: readonly RunRecord[]): string[] {
  const problems: string[] = [];
  for (const r of records) {
    r.phases.forEach((p, i) => {
      if (!p.footprint?.kv) return;
      const amp = amplification(r, i);
      if (amp && amp.userIn > 0 && !(amp.log > 0)) problems.push(`${r.workload} ${r.contender} ${p.name}: user bytes but no log bytes counted`);
    });
  }
  return problems;
}

/** Opt-in ceiling on the SharedWorker's peak: the sum of three peaks (an upper bound): JS heap in use, ArrayBuffer backing store, wasm memory. Chrome's backing counter does not include wasm memory (bench/probes/memory.ts). */
function peakChecks(records: readonly RunRecord[], maxBytes: number): string[] {
  const problems: string[] = [];
  for (const r of records) {
    const sw = r.memory?.sharedWorker;
    if (!sw) continue;
    const peak = sw.usedSize + (sw.backingStorageSize ?? 0) + (r.memory?.sharedWorkerWasmBytes ?? 0);
    if (peak > maxBytes) problems.push(`${r.workload} ${r.contender} rep ${r.rep}: SharedWorker peak ${peak} B > --max-peak-bytes ${maxBytes}`);
  }
  return problems;
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

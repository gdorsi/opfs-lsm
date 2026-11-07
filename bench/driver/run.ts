/**
 * Executes a plan. One run = one Chrome launch on a fresh profile = one
 * RunRecord, appended to the results file as soon as it finishes, so a crash
 * loses one run, not the suite. Runs are sequential: two Chromes would share
 * disk and cores.
 */
import { appendFileSync } from "node:fs";
import type { Catalog, PhaseReply, PhaseRequest, PhaseResult, RunRecord } from "../core/types.ts";
import { launchChrome } from "./chrome.ts";
import { hostInfo } from "./host.ts";
import type { PlannedRun } from "./plan.ts";

export type RunOptions = {
  readonly origin: string;
  readonly headless: boolean;
  readonly resultsFile: string;
  readonly phaseTimeoutMs: number;
  readonly log: (line: string) => void;
};

/** Ask the page for the catalog (the page owns discovery; Node never imports workload code). */
export async function readCatalog(origin: string, headless: boolean): Promise<Catalog> {
  const chrome = await launchChrome({ headless, onProgress: () => {} });
  try {
    const tab = await chrome.openTab(`${origin}/index.html`);
    return await tab.evaluate<Catalog>("__bench.catalog()", 30_000);
  } finally {
    await chrome.close();
  }
}

export async function runPlan(runs: readonly PlannedRun[], opts: RunOptions): Promise<RunRecord[]> {
  const records: RunRecord[] = [];
  for (const [i, run] of runs.entries()) {
    const record = await runOne(run, opts);
    appendFileSync(opts.resultsFile, JSON.stringify(record) + "\n");
    records.push(record);
    const status = record.error ? `FAIL ${record.error.split("\n")[0]}` : summarize(record.phases);
    opts.log(`[${i + 1}/${runs.length}] ${run.workload} ${run.contender} ${run.size} rep ${run.rep}: ${status}`);
  }
  return records;
}

async function runOne(run: PlannedRun, opts: RunOptions): Promise<RunRecord> {
  const phases: PhaseResult[] = [];
  let meta: Pick<RunRecord, "durability" | "fastPath" | "params"> | undefined;
  let chromeVersion = "unknown";
  let error: string | undefined;
  const chrome = await launchChrome({ headless: opts.headless, onProgress: (line) => opts.log(`    ${line}`) });
  try {
    chromeVersion = chrome.version;
    const url = `${opts.origin}/index.html`;
    let tab = await chrome.openTab(url);
    let carry: string | undefined;
    for (const [phase, page] of run.pages.entries()) {
      if (page === "fresh" && phase > 0) {
        await tab.evaluate("__bench.closeStore()", 60_000);
        await tab.close();
        await chrome.sharedWorkersGone(15_000); // the kv host must be gone, or "cold" is warm
        tab = await chrome.openTab(url);
      }
      const req: PhaseRequest = {
        workload: run.workload,
        contender: run.contender,
        size: run.size,
        rep: run.rep,
        phase,
        dbName: "bench",
        carry,
      };
      const reply = await tab.evaluate<PhaseReply>(`__bench.runPhase(${JSON.stringify(req)})`, opts.phaseTimeoutMs);
      carry = reply.carry;
      meta = { durability: reply.durability, fastPath: reply.fastPath, params: reply.params };
      phases.push(reply.result);
    }
    await tab.evaluate("__bench.closeStore()", 60_000);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    await chrome.close();
  }
  return {
    workload: run.workload,
    contender: run.contender,
    durability: meta?.durability ?? "none",
    fastPath: meta?.fastPath ?? "",
    size: run.size,
    rep: run.rep,
    params: meta?.params ?? { entries: 0, keyBytes: 0, valueBytes: 0, compressibility: 0, batch: 0, ops: 0, seed: 0 },
    host: hostInfo(chromeVersion, opts.headless),
    phases,
    ...(error !== undefined ? { error } : {}),
  };
}

function summarize(phases: readonly PhaseResult[]): string {
  return phases
    .filter((p) => p.timed)
    .map((p) => `${p.name} ${p.wallMs.toFixed(0)}ms`)
    .join(", ");
}

/**
 * Executes a plan. One run = one Chrome launch on a fresh profile = one
 * RunRecord, appended to the results file as soon as it finishes, so a crash
 * loses one run, not the suite. Runs are sequential: two Chromes would share
 * disk and cores.
 */
import { appendFileSync } from "node:fs";
import type { Catalog, KvOptions, MemoryPeaks, PhaseReply, PhaseRequest, PhaseResult, RunRecord } from "../core/types.ts";
import { launchChrome, type Tab } from "./chrome.ts";
import { hostInfo } from "./host.ts";
import type { PlannedRun } from "./plan.ts";
import { tabPlan } from "./tabs.ts";

export type RunOptions = {
  readonly origin: string;
  readonly headless: boolean;
  readonly resultsFile: string;
  readonly phaseTimeoutMs: number;
  readonly kv: KvOptions;
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
  const rounds: PhaseResult[][] = run.phases.map(() => []);
  let meta: Pick<PhaseReply, "durability" | "fastPath" | "engine" | "params"> | undefined;
  let chromeVersion = "unknown";
  let memory: MemoryPeaks | undefined;
  let error: string | undefined;
  const chrome = await launchChrome({ headless: opts.headless, onProgress: (line) => opts.log(`    ${line}`) });
  try {
    chromeVersion = chrome.version;
    const query = new URLSearchParams(Object.entries(opts.kv).map(([option, bytes]) => [option, String(bytes)]));
    const url = `${opts.origin}/index.html${query.size > 0 ? `?${query}` : ""}`;
    let tabs: [Tab | undefined, Tab | undefined] = [undefined, undefined];
    let carry: string | undefined;
    const freshTabs = async () => {
      for (const tab of tabs) await tab?.evaluate("__bench.closeStore()", 60_000);
      for (const tab of tabs) await tab?.close();
      tabs = [undefined, undefined];
      await chrome.sharedWorkersGone(15_000); // the kv host must be gone, or "cold" is warm
    };
    for (const { phase, round, fresh, slot } of tabPlan(run.phases)) {
      if (fresh) await freshTabs();
      const tab = (tabs[slot] ??= await chrome.openTab(url));
      const req: PhaseRequest = {
        workload: run.workload,
        contender: run.contender,
        size: run.size,
        rep: run.rep,
        phase,
        round,
        dbName: "bench",
        carry,
      };
      const reply = await tab.evaluate<PhaseReply>(`__bench.runPhase(${JSON.stringify(req)})`, opts.phaseTimeoutMs);
      carry = reply.carry;
      meta = { durability: reply.durability, fastPath: reply.fastPath, engine: reply.engine, params: reply.params };
      rounds[phase]!.push(reply.result);
    }
    memory = await chrome.memory();
    for (const tab of tabs) await tab?.evaluate("__bench.closeStore()", 60_000);
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
    ...(meta?.engine && Object.keys(opts.kv).length > 0 ? { kv: opts.kv } : {}),
    phases: rounds.flatMap(([first, ...later]) => (!first ? [] : later.length > 0 ? [{ ...first, laterRounds: later }] : [first])),
    ...(memory ? { memory } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

function summarize(phases: readonly PhaseResult[]): string {
  return phases
    .filter((p) => p.timed)
    .map((p) => `${p.name} ${p.wallMs.toFixed(0)}ms`)
    .join(", ");
}

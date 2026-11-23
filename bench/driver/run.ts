/**
 * Executes a plan. One run = one Chrome launch on a fresh profile = one
 * RunRecord, appended to the results file as soon as it finishes, so a crash
 * loses one run, not the suite. Runs are sequential: two Chromes would share
 * disk and cores.
 */
import { appendFileSync } from "node:fs";
import { DEFAULT_SEED, type Catalog, type KvOptions, type MemoryPeaks, type PhaseReply, type PhaseRequest, type PhaseResult, type RunRecord } from "../core/types.ts";
import { launchChrome, type Tab } from "./chrome.ts";
import { hostInfo } from "./host.ts";
import type { PlannedRun } from "./plan.ts";
import { tabPlan } from "./tabs.ts";

/**
 * Chrome keeps an origin's IndexedDB backing store open for 2 s after its last
 * connection closes, so a tab opened sooner finds it warm. Opens after 2 s or
 * more cost the same (19 ms against 1 ms for a 200k-row store); the wait keeps
 * 1 s of margin.
 */
const BACKING_STORE_GRACE_MS = 3000;

/** Waits out the backing store's grace, so the next tab opens it cold. */
export const waitBackingStoreCold = () => new Promise((resolve) => setTimeout(resolve, BACKING_STORE_GRACE_MS));

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
    opts.log(`[${i + 1}/${runs.length}] ${run.workload} ${run.contender} ${run.size} rep ${run.rep}${run.seed === DEFAULT_SEED ? "" : ` seed ${run.seed}`}: ${status}`);
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
    let opened = 0;
    const freshTabs = async () => {
      for (const tab of tabs) await tab?.evaluate("__bench.closeStore()", 60_000);
      for (const tab of tabs) await tab?.close();
      tabs = [undefined, undefined];
      await chrome.sharedWorkersGone(15_000); // the kv host must be gone, or "cold" is warm
      await waitBackingStoreCold();
    };
    for (const { phase, round, fresh, slot } of tabPlan(run.phases)) {
      if (fresh) await freshTabs();
      // Only the run's first tab touches storage: a touch in a later tab opens the IndexedDB backing store before the timed open.
      const tab = (tabs[slot] ??= await chrome.openTab(opened++ === 0 ? `${url}${query.size > 0 ? "&" : "?"}touch` : url));
      const req: PhaseRequest = {
        workload: run.workload,
        contender: run.contender,
        size: run.size,
        rep: run.rep,
        phase,
        round,
        seed: run.seed,
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
    params: meta?.params ?? { entries: 0, keyBytes: 0, valueBytes: 0, compressibility: 0, batch: 0, ops: 0, seed: run.seed },
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

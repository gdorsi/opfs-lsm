/**
 * How much of each fate phase is storage and how much is fate. Chrome only.
 *
 *   node bench/probes/fate-storage.ts [workload…] [--size tiny|small|large] [--contenders kv,indexeddb]
 *
 * Runs every fate workload once per contender with the storage the client sees
 * wrapped by a recorder (`?recordStorage`, see `page/fate.ts`), and prints per
 * phase and contender:
 *
 *   wall      the phase body's time, as the bench measures it
 *   storage   time in which at least one storage call was in flight: reads, scans,
 *             writeBatch, and for kv the `db.sync()` in a lock grant (the union of
 *             the calls, so overlapping calls count once; waits for a lock are not
 *             storage, they are fate waiting on its own other work)
 *   fate      wall - storage: fate's own work, timers, lock waits, and idle time
 *   calls     for each kind, the number of calls / the sum of their times in ms.
 *             Sums add up the calls even when they overlap, so they can pass the wall.
 *             wait = from asking for a lock to the grant; held = time inside lock
 *             grants; sync = kv's `db.sync()`, inside the grants; idbOpen = calls to
 *             `indexedDB.open` (a count, no time); yield = setTimeout(0)
 *             timers, from schedule to run (fate yields every 64 steps while saving,
 *             loading and walking the mutation journal)
 *
 * The recorder adds a promise to each call and a wrapper to setTimeout, so these
 * numbers explain the bench's; they are not results.
 */
import path from "node:path";
import { parseArgs } from "node:util";
import type { PhaseReply, PhaseRequest, SizeName } from "../core/types.ts";
import { BENCH_DIR, buildBench } from "../driver/build.ts";
import { launchChrome } from "../driver/chrome.ts";
import { DATA_DIR } from "../driver/data.ts";
import { plan } from "../driver/plan.ts";
import { readCatalog } from "../driver/run.ts";
import { serve } from "../driver/serve.ts";

type Kind = { calls: number; ms: number };
type Taken = { kinds: Record<string, Kind | undefined>; inStorageMs: number };
type Row = { workload: string; contender: string; index: number; phase: string; timed: boolean; wallMs: number; taken: Taken };

const KINDS = ["read", "scan", "writeBatch", "wait", "held", "sync", "idbOpen", "yield"] as const;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { size: { type: "string", default: "small" }, contenders: { type: "string", default: "" } },
});
const size = values.size as SizeName;
const selected = positionals.length > 0 ? positionals : ["fate/"];

await buildBench({ quiet: true });
const server = await serve({ "/": path.join(BENCH_DIR, ".out"), "/data/": DATA_DIR });
const rows: Row[] = [];
try {
  const catalog = await readCatalog(server.origin, true);
  const runs = plan(catalog, { workloads: selected, contenders: values.contenders ? values.contenders.split(",") : [], size, reps: 1 });
  for (const run of runs) {
    if (!run.workload.startsWith("fate/")) throw new Error(`${run.workload} is not a fate workload`);
    console.error(`${run.workload} ${run.contender} ${size}`);
    const names = catalog.find((w) => w.workload === run.workload)!.phases.map((p) => p.name);
    const chrome = await launchChrome({ headless: true, onProgress: () => {} });
    try {
      const url = `${server.origin}/index.html?recordStorage`;
      let tab = await chrome.openTab(url);
      let carry: string | undefined;
      for (const [phase, page] of run.pages.entries()) {
        if (page === "fresh" && phase > 0) {
          await tab.evaluate("__bench.closeStore()", 60_000);
          await tab.close();
          await chrome.sharedWorkersGone(15_000);
          tab = await chrome.openTab(url);
        }
        const req: PhaseRequest = { workload: run.workload, contender: run.contender, size, rep: 0, phase, dbName: "bench", carry };
        const reply = await tab.evaluate<PhaseReply>(`__bench.runPhase(${JSON.stringify(req)})`, 1_800_000);
        carry = reply.carry;
        const taken = await tab.evaluate<Taken>("Promise.resolve(__fateStorage.take())", 60_000);
        rows.push({ workload: run.workload, contender: run.contender, index: phase, phase: names[phase]!, timed: reply.result.timed, wallMs: reply.result.wallMs, taken });
      }
      await tab.evaluate("__bench.closeStore()", 60_000);
    } finally {
      await chrome.close();
    }
  }
} finally {
  await server.close();
}

const ms = (x: number) => x.toFixed(x < 100 ? 1 : 0);
const cell = (k: Kind | undefined) => (k ? `${k.calls} / ${ms(k.ms)}` : "–");
for (const workload of [...new Set(rows.map((r) => r.workload))]) {
  console.log(`\n## ${workload} ${size}\n`);
  console.log(`| phase | contender | wall ms | storage ms | fate ms | ${KINDS.map((k) => `${k} n / ms`).join(" | ")} |`);
  console.log(`|---|---|---:|---:|---:|${KINDS.map(() => "---:").join("|")}|`);
  for (const r of rows.filter((row) => row.workload === workload).sort((a, b) => a.index - b.index || a.contender.localeCompare(b.contender))) {
    const label = r.timed ? r.phase : `${r.phase} (untimed)`;
    console.log(`| ${label} | ${r.contender} | ${ms(r.wallMs)} | ${ms(r.taken.inStorageMs)} | ${ms(r.wallMs - r.taken.inStorageMs)} | ${KINDS.map((k) => cell(r.taken.kinds[k])).join(" | ")} |`);
  }
}

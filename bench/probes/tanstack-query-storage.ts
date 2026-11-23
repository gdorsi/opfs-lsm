/**
 * How much of each phase of a TanStack Query workload is the persister's
 * storage calls and how much is TanStack's own work. Chrome only.
 *
 *   node bench/probes/tanstack-query-storage.ts [workload…] [--size tiny|small|large] [--contenders kv,indexeddb]
 *
 * Runs each selected workload once per contender with the persister's calls
 * wrapped by a recorder (`?recordStorage`, see `page/tanstack-query.ts`), and
 * prints per phase and contender:
 *
 *   span       from the start of the phase's first timed call to the end of its last,
 *              what its ops/s divides by; the whole body for an untimed phase
 *   storage    time in which at least one persistQuery or restoreQueries call was
 *              in flight (the union of the calls, so overlapping calls count once).
 *              It includes TanStack's JSON work, which serialize and deserialize
 *              record on their own.
 *   tanstack   span - storage: TanStack's own work, the fetches and idle time
 *   calls      for each kind, the number of calls / the sum of their times in ms.
 *              Sums add up the calls even when they overlap, so they can pass the wall.
 *
 * The recorder adds a promise to each call, so these numbers explain the
 * bench's; they are not results.
 */
import path from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_SEED, type PhaseReply, type PhaseRequest, type SizeName } from "../core/types.ts";
import { BENCH_DIR, buildBench } from "../driver/build.ts";
import { launchChrome } from "../driver/chrome.ts";
import { DATA_DIR } from "../driver/data.ts";
import { plan } from "../driver/plan.ts";
import { readCatalog, waitBackingStoreCold } from "../driver/run.ts";
import { serve } from "../driver/serve.ts";

type Kind = { calls: number; ms: number };
type Taken = { kinds: Record<string, Kind | undefined>; inStorageMs: number };
type Row = { workload: string; contender: string; index: number; phase: string; timed: boolean; spanMs: number; taken: Taken };

const KINDS = ["persistQuery", "restoreQueries", "serialize", "deserialize"] as const;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { size: { type: "string", default: "small" }, contenders: { type: "string", default: "" } },
});
const size = values.size as SizeName;
const selected = positionals.length > 0 ? positionals : ["tanstack-query/"];

await buildBench({ quiet: true });
const server = await serve({ "/": path.join(BENCH_DIR, ".out"), "/data/": DATA_DIR });
const rows: Row[] = [];
try {
  const catalog = await readCatalog(server.origin, true);
  const runs = plan(catalog, { workloads: selected, contenders: values.contenders ? values.contenders.split(",") : [], size, reps: 1, seed: DEFAULT_SEED });
  for (const run of runs) {
    if (run.phases.some(({ page }) => page === "other")) throw new Error(`${run.workload} runs a phase in a second tab, which this probe does not open`);
    if (!run.workload.startsWith("tanstack-query/")) throw new Error(`${run.workload} is not a tanstack-query workload`);
    console.error(`${run.workload} ${run.contender} ${size}`);
    const names = catalog.find((w) => w.workload === run.workload)!.phases.map((p) => p.name);
    const chrome = await launchChrome({ headless: true, onProgress: () => {} });
    try {
      const url = `${server.origin}/index.html?recordStorage`;
      let tab = await chrome.openTab(`${url}&touch`);
      let carry: string | undefined;
      for (const [phase, { page }] of run.phases.entries()) {
        if (page === "fresh" && phase > 0) {
          await tab.evaluate("__bench.closeStore()", 60_000);
          await tab.close();
          await chrome.sharedWorkersGone(15_000);
          await waitBackingStoreCold();
          tab = await chrome.openTab(url);
        }
        const req: PhaseRequest = { workload: run.workload, contender: run.contender, size, rep: 0, phase, round: 0, seed: run.seed, dbName: "bench", carry };
        const reply = await tab.evaluate<PhaseReply>(`__bench.runPhase(${JSON.stringify(req)})`, 1_800_000);
        carry = reply.carry;
        const taken = await tab.evaluate<Taken>("Promise.resolve(__storageCalls.take())", 60_000);
        rows.push({ workload: run.workload, contender: run.contender, index: phase, phase: names[phase]!, timed: reply.result.timed, spanMs: reply.result.timed ? reply.result.spanMs : reply.result.wallMs, taken });
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
  console.log(`| phase | contender | span ms | storage ms | tanstack ms | ${KINDS.map((k) => `${k} n / ms`).join(" | ")} |`);
  console.log(`|---|---|---:|---:|---:|${KINDS.map(() => "---:").join("|")}|`);
  for (const r of rows.filter((row) => row.workload === workload).sort((a, b) => a.index - b.index || a.contender.localeCompare(b.contender))) {
    const label = r.timed ? r.phase : `${r.phase} (untimed)`;
    console.log(`| ${label} | ${r.contender} | ${ms(r.spanMs)} | ${ms(r.taken.inStorageMs)} | ${ms(r.spanMs - r.taken.inStorageMs)} | ${KINDS.map((k) => cell(r.taken.kinds[k])).join(" | ")} |`);
  }
}

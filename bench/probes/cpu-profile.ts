/**
 * Where one phase of a workload spends CPU, in the tab and in the SharedWorker.
 *
 *   node bench/probes/cpu-profile.ts <workload> <phase> [--contender kv/kv] [--size small] [--top 25]
 *
 * Runs the workload's phases in order like the driver, fresh pages included,
 * and records a V8 CPU profile of the named phase only. A second DevTools
 * client starts the profiler in the tab before the phase and in the
 * SharedWorker as soon as it shows up, so a worker the phase itself starts
 * loses its first milliseconds. Prints self time per function and writes each
 * profile to bench/results/ for DevTools. The build is not minified, so
 * the names are the source's. Profiling slows the run, so compare
 * shares between functions, not the wall time with an unprofiled run.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { PhaseReply, PhaseRequest, SizeName } from "../core/types.ts";
import { BENCH_DIR, buildBench } from "../driver/build.ts";
import { launchChrome } from "../driver/chrome.ts";
import { DATA_DIR, ensureTrace } from "../driver/data.ts";
import { plan } from "../driver/plan.ts";
import { readCatalog } from "../driver/run.ts";
import { serve } from "../driver/serve.ts";

type CallFrame = { functionName: string; url: string; lineNumber: number };
type Profile = {
  nodes: { id: number; callFrame: CallFrame }[];
  samples: number[];
  timeDeltas: number[];
};
type Reply = { id?: number; result?: unknown; error?: { message: string } };

async function connect(url: string) {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error(`cannot connect to ${url}`));
  });
  let next = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data)) as Reply;
    if (msg.id === undefined) return;
    const call = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) call?.reject(new Error(msg.error.message));
    else call?.resolve(msg.result);
  };
  const send = <T>(method: string, params: object = {}, sessionId?: string) =>
    new Promise<T>((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  const attach = async (type: string): Promise<string | undefined> => {
    const { targetInfos } = await send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets");
    const target = targetInfos.find((t) => t.type === type && !t.url.startsWith("about:"));
    if (!target) return undefined;
    const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    return sessionId;
  };
  const start = async (sessionId: string) => {
    await send("Profiler.enable", {}, sessionId);
    await send("Profiler.setSamplingInterval", { interval: 100 }, sessionId);
    await send("Profiler.start", {}, sessionId);
  };
  const stop = async (sessionId: string) => (await send<{ profile: Profile }>("Profiler.stop", {}, sessionId)).profile;
  return { attach, start, stop, close: () => ws.close() };
}

/** Self milliseconds per function, largest first. */
function selfTimes(profile: Profile): { name: string; ms: number }[] {
  const byNode = new Map(profile.nodes.map((n) => [n.id, n.callFrame]));
  const totals = new Map<string, number>();
  profile.samples.forEach((id, i) => {
    const f = byNode.get(id)!;
    const where = f.url ? ` ${path.basename(f.url.split("?")[0]!)}:${f.lineNumber + 1}` : "";
    const name = `${f.functionName || "(anonymous)"}${where}`;
    totals.set(name, (totals.get(name) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
  });
  return [...totals].map(([name, ms]) => ({ name, ms })).sort((a, b) => b.ms - a.ms);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    contender: { type: "string", default: "kv/kv" },
    size: { type: "string", default: "small" },
    top: { type: "string", default: "25" },
  },
});
const [workload, phaseName] = positionals;
if (!workload || !phaseName) throw new Error("usage: cpu-profile.ts <workload> <phase>");
const top = Number(values.top);

await ensureTrace();
await buildBench({ quiet: true, minify: false });
const server = await serve({ "/": path.join(BENCH_DIR, ".out"), "/data/": DATA_DIR });
try {
  const catalog = await readCatalog(server.origin, true);
  const [run] = plan(catalog, { workloads: [workload], contenders: [values.contender!], size: values.size as SizeName, reps: 1 });
  if (!run) throw new Error(`nothing to run for ${workload} on ${values.contender}`);
  const names = catalog.find((w) => w.workload === workload)!.phases.map((p) => p.name);
  const target = names.indexOf(phaseName);
  if (target < 0) throw new Error(`${workload} has no phase ${phaseName}; it has ${names.join(", ")}`);

  const chrome = await launchChrome({ headless: true, onProgress: () => {} });
  const profiles: { side: string; profile: Profile }[] = [];
  try {
    const [port, endpoint] = readFileSync(path.join(chrome.profile, "DevToolsActivePort"), "utf8").split("\n");
    const cdp = await connect(`ws://127.0.0.1:${port}${endpoint}`);
    const url = `${server.origin}/index.html`;
    let tab = await chrome.openTab(url);
    let carry: string | undefined;
    for (const [phase, page] of run.pages.entries()) {
      if (page === "fresh" && phase > 0) {
        await tab.evaluate("__bench.closeStore()", 60_000);
        await tab.close();
        await chrome.sharedWorkersGone(15_000);
        tab = await chrome.openTab(url);
      }
      const req: PhaseRequest = { workload: run.workload, contender: run.contender, size: run.size, rep: 0, phase, dbName: "bench", carry };
      if (phase !== target) {
        carry = (await tab.evaluate<PhaseReply>(`__bench.runPhase(${JSON.stringify(req)})`, 1_800_000)).carry;
        continue;
      }
      const tabSession = (await cdp.attach("page"))!;
      await cdp.start(tabSession);
      let worker = await cdp.attach("shared_worker");
      if (worker) await cdp.start(worker);
      let done = false;
      const reply = tab.evaluate<PhaseReply>(`__bench.runPhase(${JSON.stringify(req)})`, 1_800_000);
      void reply.finally(() => (done = true)).catch(() => {});
      while (!done && !worker) {
        await sleep(2);
        worker = await cdp.attach("shared_worker");
        if (worker) await cdp.start(worker);
      }
      const result = await reply;
      carry = result.carry;
      profiles.push({ side: "tab", profile: await cdp.stop(tabSession) });
      if (worker) profiles.push({ side: "worker", profile: await cdp.stop(worker) });
      console.log(`${workload} ${phaseName} on ${run.contender}, ${run.size}: wall ${result.result.wallMs.toFixed(0)} ms (profiled)`);
    }
    await tab.evaluate("__bench.closeStore()", 60_000);
    cdp.close();
  } finally {
    await chrome.close();
  }

  const dir = path.join(BENCH_DIR, "results");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  for (const { side, profile } of profiles) {
    const file = path.join(dir, `${stamp}-${workload.replace("/", "-")}-${phaseName}-${side}.cpuprofile`);
    writeFileSync(file, JSON.stringify(profile));
    const rows = selfTimes(profile);
    const busy = rows.filter((r) => !r.name.startsWith("(idle)")).reduce((s, r) => s + r.ms, 0);
    console.log(`\n${side}: ${busy.toFixed(0)} ms busy, ${file}`);
    for (const r of rows.slice(0, top)) console.log(`${r.ms.toFixed(1).padStart(9)} ms  ${r.name}`);
  }
} finally {
  await server.close();
}

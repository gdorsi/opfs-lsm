/**
 * What the SharedWorker keeps alive while a workload runs. Chrome only.
 *
 *   node bench/probes/live-set.ts [workload] [--size small] [--compaction-memory-bytes N] [--every-ms 500]
 *
 * The run record's SharedWorker peak (`Runtime.getHeapUsage` every 100 ms)
 * counts objects and ArrayBuffers that are already garbage and that V8 has
 * not collected yet. A heap snapshot is written after a full collection, so
 * it counts only what is alive. A second DevTools session takes one every
 * `--every-ms`. Each pauses the worker for a few hundred milliseconds, so the
 * run is slower than an unobserved one and its timings mean nothing.
 *
 * The wasm memory is the one ArrayBuffer past 4 MiB. The JS side is every
 * other byte in the snapshot: objects on the V8 heap and the other
 * ArrayBuffers. The default workload is kv/compaction-memory. A workload
 * whose phases need a fresh page is refused.
 */
import { readFileSync } from "node:fs";
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

const MiB = 1024 * 1024;
const BUFFER_DATA = "system / JSArrayBufferData";

type Snapshot = {
  readonly nodes: readonly number[];
  readonly strings: readonly string[];
  readonly snapshot: { readonly meta: { readonly node_fields: readonly string[]; readonly node_types: readonly [readonly string[]] } };
};

/** The wasm memory and everything else in a heap snapshot, in bytes. */
function liveSet(text: string): { jsBytes: number; wasmBytes: number } {
  const snap = JSON.parse(text) as Snapshot;
  const { node_fields: fields, node_types: types } = snap.snapshot.meta;
  const width = fields.length;
  const type = fields.indexOf("type");
  const name = fields.indexOf("name");
  const size = fields.indexOf("self_size");
  const native = types[0].indexOf("native");
  let total = 0;
  let wasm = 0;
  for (let i = 0; i < snap.nodes.length; i += width) {
    const bytes = snap.nodes[i + size]!;
    total += bytes;
    if (snap.nodes[i + type] === native && snap.strings[snap.nodes[i + name]!] === BUFFER_DATA && bytes > 4 * MiB) wasm += bytes;
  }
  return { jsBytes: total - wasm, wasmBytes: wasm };
}

type Reply = { id?: number; method?: string; params?: { chunk: string }; result?: unknown; error?: { message: string } };

/** A second client on the browser's DevTools socket. The driver owns the first. */
async function connect(url: string) {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error(`cannot connect to ${url}`));
  });
  let next = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const chunks: string[] = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data)) as Reply;
    if (msg.id !== undefined) {
      const call = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) call?.reject(new Error(msg.error.message));
      else call?.resolve(msg.result);
    } else if (msg.method === "HeapProfiler.addHeapSnapshotChunk" && msg.params) chunks.push(msg.params.chunk);
  };
  const send = <T>(method: string, params: object = {}, sessionId?: string) =>
    new Promise<T>((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  return {
    send,
    async attachToSharedWorker(): Promise<string | undefined> {
      const { targetInfos } = await send<{ targetInfos: { targetId: string; type: string }[] }>("Target.getTargets");
      const target = targetInfos.find((t) => t.type === "shared_worker");
      if (!target) return undefined;
      const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true });
      return sessionId;
    },
    async snapshot(sessionId: string): Promise<string> {
      chunks.length = 0;
      await send("HeapProfiler.takeHeapSnapshot", { reportProgress: false }, sessionId);
      return chunks.splice(0).join("");
    },
    close: () => ws.close(),
  };
}

const median = (xs: readonly number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1] ?? 0;
const mib = (bytes: number) => (bytes / MiB).toFixed(1).padStart(6);

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    size: { type: "string", default: "small" },
    "compaction-memory-bytes": { type: "string", default: "" },
    "every-ms": { type: "string", default: "500" },
  },
});
const workload = positionals[0] ?? "kv/compaction-memory";
const size = values.size as SizeName;
const everyMs = Number(values["every-ms"]);
const query = values["compaction-memory-bytes"] ? `?compactionMemoryBytes=${values["compaction-memory-bytes"]}` : "";

await ensureTrace();
await buildBench({ quiet: true });
const server = await serve({ "/": path.join(BENCH_DIR, ".out"), "/data/": DATA_DIR });
try {
  const catalog = await readCatalog(server.origin, true);
  const [run] = plan(catalog, { workloads: [workload], contenders: ["kv/kv"], size, reps: 1 });
  if (!run) throw new Error(`nothing to run for ${workload}`);
  if (run.pages.some((page, phase) => phase > 0 && page === "fresh")) throw new Error(`${workload} opens a fresh page, so it has no one SharedWorker to watch`);
  const phaseNames = catalog.find((w) => w.workload === workload)!.phases.map((p) => p.name);

  const chrome = await launchChrome({ headless: true, onProgress: () => {} });
  const samples: { t: number; phase: string; jsBytes: number; wasmBytes: number }[] = [];
  try {
    const [port, endpoint] = readFileSync(path.join(chrome.profile, "DevToolsActivePort"), "utf8").split("\n");
    const cdp = await connect(`ws://127.0.0.1:${port}${endpoint}`);
    const tab = await chrome.openTab(`${server.origin}/index.html${query}`);
    const started = Date.now();
    let worker: string | undefined;
    let carry: string | undefined;
    for (const [phase, name] of phaseNames.entries()) {
      const req: PhaseRequest = { workload: run.workload, contender: run.contender, size: run.size, rep: 0, phase, dbName: "bench", carry };
      let done = false;
      const reply = tab.evaluate<PhaseReply>(`__bench.runPhase(${JSON.stringify(req)})`, 1_800_000);
      void reply.finally(() => (done = true)).catch(() => {});
      while (!done) {
        await sleep(everyMs);
        worker ??= await cdp.attachToSharedWorker();
        if (done || !worker) continue;
        samples.push({ t: Date.now() - started, phase: name, ...liveSet(await cdp.snapshot(worker)) });
      }
      carry = (await reply).carry;
    }
    await tab.evaluate("__bench.closeStore()", 60_000);
    cdp.close();
  } finally {
    await chrome.close();
  }

  console.log(`${workload} ${size}${query ? `, compactionMemoryBytes ${values["compaction-memory-bytes"]}` : ""}: SharedWorker, MiB`);
  console.log(`${"t (s)".padStart(6)}  ${"phase".padEnd(8)}${"JS side".padStart(8)}${"wasm".padStart(8)}${"sum".padStart(8)}`);
  for (const s of samples) {
    console.log(`${(s.t / 1000).toFixed(1).padStart(6)}  ${s.phase.padEnd(8)}${mib(s.jsBytes)}  ${mib(s.wasmBytes)}  ${mib(s.jsBytes + s.wasmBytes)}`);
  }
  console.log(`\n${"phase".padEnd(8)}${"n".padStart(4)}${"JS median".padStart(11)}${"JS max".padStart(8)}${"wasm max".padStart(10)}${"sum max".padStart(9)}`);
  for (const name of phaseNames) {
    const rows = samples.filter((s) => s.phase === name);
    if (rows.length === 0) continue;
    const max = (pick: (s: (typeof rows)[number]) => number) => Math.max(...rows.map(pick));
    console.log(
      `${name.padEnd(8)}${String(rows.length).padStart(4)}${mib(median(rows.map((s) => s.jsBytes))).padStart(11)}${mib(max((s) => s.jsBytes)).padStart(8)}${mib(max((s) => s.wasmBytes)).padStart(10)}${mib(max((s) => s.jsBytes + s.wasmBytes)).padStart(9)}`,
    );
  }
} finally {
  await server.close();
}

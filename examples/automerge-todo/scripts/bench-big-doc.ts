/**
 * One big Automerge document on kv vs IndexedDB, in headless Chrome, one fresh profile per run.
 * Inputs come from automerge's rust/benchmark-battery, downloaded once into bench-data/.
 *
 *   pnpm --filter @opfs-lsm/example-automerge bench:big-doc
 *   BENCH_WORKLOADS=trace:10,data/essay.amrg BENCH_RUNS=5 pnpm --filter @opfs-lsm/example-automerge bench:big-doc
 *   BENCH_KV_WAL=default,262144 pnpm --filter @opfs-lsm/example-automerge bench:big-doc   # kv ingest triggers
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Plugin } from "vite";
import { METRICS, parseWorkload, type Params, type RunResult, type Variant } from "../bench/big-doc-metrics.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNS = Number(process.env.BENCH_RUNS ?? 3);
const LOADS = Number(process.env.BENCH_LOADS ?? 5);
const WORKLOADS = (process.env.BENCH_WORKLOADS ?? "trace:100,data/moby-dick.automerge,data/essay.amrg").split(",");
const RUN_TIMEOUT_MS = 30 * 60_000;
const VARIANTS: Variant[] = [
  ...(process.env.BENCH_KV_WAL ?? "default").split(",").map((w): Variant =>
    w === "default" ? { label: "kv", adapter: "kv" } : { label: `kv@${w}`, adapter: "kv", walBytes: Number(w) },
  ),
  { label: "idb", adapter: "idb" },
  { label: "mem", adapter: "mem" },
];
const BASELINE = VARIANTS.findIndex((v) => v.label === "idb");

/** Pinned so a rerun measures the same inputs. */
const BATTERY_COMMIT = "5994c3967077976ad79656a6bb933f0a6c24be96";
const dataDir = path.join(root, "bench-data");

async function ensureData(file: string): Promise<void> {
  const dest = path.join(dataDir, file);
  if (fs.existsSync(dest)) return;
  const url = `https://raw.githubusercontent.com/automerge/automerge/${BATTERY_COMMIT}/rust/benchmark-battery/${file}`;
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${file}: ${res.status}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

for (const spec of WORKLOADS) {
  const w = parseWorkload(spec);
  await ensureData(w.kind === "trace" ? "data/edits.json" : w.file);
}

function chromePath(): string {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return fs.existsSync(mac) ? mac : "google-chrome";
}

function killChrome(child: ChildProcess): void {
  try {
    process.kill(-child.pid!, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

let deliver: ((result: RunResult) => void) | null = null;

const resultsPlugin: Plugin = {
  name: "bench-results",
  configureServer(server) {
    // Cross-origin isolation lifts performance.now() from 100 µs to 5 µs steps.
    server.middlewares.use((_req, res, next) => {
      res.setHeader("cross-origin-opener-policy", "same-origin");
      res.setHeader("cross-origin-embedder-policy", "require-corp");
      next();
    });
    server.middlewares.use("/bench-results", async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      res.end("ok");
      deliver?.(JSON.parse(Buffer.concat(chunks).toString("utf8")) as RunResult);
      deliver = null;
    });
  },
};

const server = await createServer({
  configFile: path.join(root, "vite.config.mjs"),
  root,
  logLevel: "warn",
  server: { port: 0 },
  plugins: [resultsPlugin],
});
await server.listen();
const address = server.httpServer!.address();
if (!address || typeof address === "string") throw new Error("expected TCP listen address");
const origin = `http://127.0.0.1:${address.port}`;

async function runOnce(variant: Variant, p: Params): Promise<RunResult> {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "automerge-bench-"));
  const wal = variant.walBytes ? `&walBytes=${variant.walBytes}` : "";
  const url = `${origin}/bench/big-doc.html?adapter=${variant.adapter}&label=${variant.label}${wal}&workload=${encodeURIComponent(p.workload)}&loads=${p.loads}`;
  const chrome = spawn(
    chromePath(),
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--enable-features=FileSystemAccessAPI",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      `--user-data-dir=${profile}`,
      url,
    ],
    { stdio: "ignore", detached: true },
  );
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<RunResult>((resolve, reject) => {
      deliver = resolve;
      timer = setTimeout(() => reject(new Error(`${variant.label} run timed out`)), RUN_TIMEOUT_MS);
      chrome.once("exit", (code) => reject(new Error(`chrome exited ${code} before results`)));
    });
  } catch (err) {
    const metrics = Object.fromEntries(METRICS.map((m) => [m.name, NaN])) as RunResult["metrics"];
    return { variant, params: p, metrics, checks: { changes: 0, docBytes: 0, goodLoads: 0, ingests: 0, errors: [String(err)] } };
  } finally {
    clearTimeout(timer);
    deliver = null;
    killChrome(chrome);
    await new Promise((r) => setTimeout(r, 200));
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const fmt = (ms: number) => (Number.isFinite(ms) ? (ms < 10 ? ms.toFixed(2) : ms.toFixed(1)) : "NaN");

console.log(`workloads ${WORKLOADS.join(", ")}; runs=${RUNS} loads=${LOADS} per variant, alternating ${VARIANTS.map((v) => v.label).join("/")}`);
const warm = await runOnce(VARIANTS[0]!, { workload: WORKLOADS[0]!, loads: 1 });
if (warm.checks.errors.length) console.log(`warmup errors ${JSON.stringify(warm.checks.errors)}`);

let failed = false;
for (const workload of WORKLOADS) {
  const params: Params = { workload, loads: LOADS };
  const results: RunResult[] = [];
  console.log(`\n== ${workload}`);
  for (let i = 0; i < RUNS; i++) {
    for (const variant of VARIANTS) {
      const r = await runOnce(variant, params);
      results.push(r);
      const line = METRICS.map((m) => `${m.name}=${fmt(r.metrics[m.name])}`).join(" ");
      const errors = r.checks.errors.length ? ` errors=${JSON.stringify(r.checks.errors)}` : "";
      console.log(`run ${i + 1} ${variant.label.padEnd(10)} ${line} ingests=${r.checks.ingests}${errors}`);
    }
  }
  const sample = results.find((r) => r.checks.docBytes > 0)?.checks;
  console.log(`doc: ${sample ? `${(sample.docBytes / 1024).toFixed(0)} KiB saved, ${sample.changes || "imported"} changes` : "never written"}`);

  const rows = METRICS.map((m) => {
    const cells = VARIANTS.map((v) => results.filter((r) => r.variant.label === v.label).map((r) => r.metrics[m.name]));
    const medians = cells.map(median);
    return [
      m.name,
      ...cells.map((xs, i) => `${fmt(medians[i]!)} (${fmt(Math.min(...xs))}-${fmt(Math.max(...xs))})`),
      ...VARIANTS.flatMap((v, i) => (i === BASELINE ? [] : [(medians[i]! / medians[BASELINE]!).toFixed(2)])),
      m.describe,
    ];
  });
  const header = [
    "metric (ms)",
    ...VARIANTS.map((v) => `${v.label} median (min-max)`),
    ...VARIANTS.filter((_, i) => i !== BASELINE).map((v) => `${v.label}/idb`),
    "what",
  ];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  for (const row of [header, ...rows]) console.log(row.map((c, i) => c.padEnd(widths[i]!)).join("  "));

  const errors = results.flatMap((r) => r.checks.errors.map((e) => `${r.variant.label}: ${e}`));
  const good = results.reduce((n, r) => n + r.checks.goodLoads, 0);
  console.log(`checks: goodLoads ${good}/${results.length * LOADS}, errors ${errors.length}`);
  for (const e of errors) console.log(`  ${e}`);
  if (errors.length || good !== results.length * LOADS) failed = true;
}
await server.close();
process.exitCode = failed ? 1 : 0;

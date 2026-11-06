/**
 * Drive bench/open.html in headless Chrome (OPFS + SharedWorker).
 *
 *   pnpm --filter @opfs-lsm/kv build
 *   pnpm --filter @opfs-lsm/example-automerge bench:open
 *
 *   RUNS=5 CASES=rows-1k,rows-5k,rows-20k,am-5k VALUE_BYTES=512 DOCS=5000
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const runs = Number(process.env.RUNS ?? 5);
const cases = process.env.CASES ?? "rows-1k,rows-5k,rows-20k,am-5k";
const valueBytes = Number(process.env.VALUE_BYTES ?? 512);
const docs = Number(process.env.DOCS ?? 5000);
const timeoutMs = Number(process.env.BENCH_TIMEOUT_MS ?? 45 * 60 * 1000);
const exampleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type Pass = {
  pass: "cold" | "warm" | "idle";
  openMs: number;
  rows: number;
  phases: Record<string, number | null>;
  gapMs: number;
  syncGapMs: number | null;
  hostScanEndedAt: number | null;
  wasmEndedAt: number | null;
  openStartedAt: number;
  openEndedAt: number;
};

type FloorRead = {
  ms: number;
  idbMs: number;
  decodeMs: number;
  rows: number;
  bytes: number;
};

type CaseResult = {
  id: string;
  kind: string;
  walRows: number;
  populateMs: number;
  valueBytes: number | null;
  docs: number | null;
  runs: { cold: Pass; warm: Pass; idle: Pass; coldScanOverlappedWarm: boolean }[];
  floor: {
    rounds: number;
    cursor: FloorRead;
    cursorCount: FloorRead;
    getAll: FloorRead;
    oneBlobMs: number;
  } | null;
};

type Published = {
  runs: number;
  valueBytes: number;
  casesKey: string;
  userAgent: string;
  results: CaseResult[];
};

const PHASES = [
  "opfs",
  "worker-ctor",
  "idb-open",
  "generation",
  "sync",
  "wal-read",
  "memtable",
  "sst",
  "wasm",
  "host-scan",
  "gap",
  "syncGap",
] as const;

function chromePath(): string {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (fs.existsSync(mac)) return mac;
  return "google-chrome";
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("expected TCP listen address"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function killProcess(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

type Target = { type?: string; url?: string; webSocketDebuggerUrl?: string };

async function listTargets(debugPort: number): Promise<Target[]> {
  const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
  if (!res.ok) throw new Error(`json/list ${res.status}`);
  return (await res.json()) as Target[];
}

function devtoolsCall(
  wsUrl: string,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`${method} timeout`));
    }, 20_000);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number;
        error?: { message?: string };
        result?: {
          exceptionDetails?: { text?: string; exception?: { description?: string } };
          result?: { value?: unknown };
        };
      };
      if (msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (msg.error) {
        reject(new Error(msg.error.message ?? `${method} failed`));
        return;
      }
      const details = msg.result?.exceptionDetails;
      if (details) {
        reject(new Error(details.exception?.description ?? details.text ?? `${method} threw`));
        return;
      }
      resolve(msg.result?.result?.value);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("devtools socket error"));
    });
  });
}

async function pageSocket(debugPort: number, pageUrl: string): Promise<string> {
  const deadline = Date.now() + 30_000;
  let last = "page missing";
  while (Date.now() < deadline) {
    try {
      const page = (await listTargets(debugPort)).find(
        (target) =>
          target.type === "page" &&
          (target.url ?? "").startsWith(pageUrl) &&
          target.webSocketDebuggerUrl,
      );
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      last = "page not listed";
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await sleep(100);
  }
  throw new Error(last);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function fmt(n: number | null): string {
  if (n === null || Number.isNaN(n)) return "        ·";
  return n.toFixed(1).padStart(9);
}

function cell(pass: Pass, phase: (typeof PHASES)[number]): number | null {
  if (phase === "gap") return pass.gapMs;
  if (phase === "syncGap") return pass.syncGapMs;
  if (phase === "open") return pass.openMs;
  return pass.phases[phase] ?? null;
}

function report(state: Published): void {
  console.log(
    `runs=${state.runs} valueBytes=${state.valueBytes} cases=${state.casesKey}`,
  );
  console.log(`ua ${state.userAgent}`);
  console.log("");
  console.log(
    "open ms is the wall clock from openDb to ready. wal-read sits inside sync and includes the IndexedDB cursor and decode. host-scan and wasm can finish after open returns. gap is open minus opfs, worker-ctor, idb-open, generation, and sync.",
  );
  for (const result of state.results) {
    console.log("");
    console.log(
      `${result.id}  walRows=${result.walRows} populateMs=${result.populateMs.toFixed(0)} overlapped=${result.runs.filter((run) => run.coldScanOverlappedWarm).length}/${result.runs.length}`,
    );
    const header = ["pass", "open", ...PHASES.filter((phase) => phase !== "open")].join(" ");
    console.log(header);
    for (const passName of ["cold", "warm", "idle"] as const) {
      const passes = result.runs.map((run) => run[passName]);
      const parts = [passName.padEnd(5)];
      parts.push(fmt(median(passes.map((pass) => pass.openMs))));
      for (const phase of PHASES) {
        if (phase === "open") continue;
        const values = passes.map((pass) => cell(pass, phase));
        const nums = values.filter((value): value is number => value !== null);
        parts.push(fmt(nums.length === 0 ? null : median(nums)));
      }
      const opens = passes.map((pass) => pass.openMs);
      console.log(
        `${parts.join(" ")}  range ${Math.min(...opens).toFixed(1)}..${Math.max(...opens).toFixed(1)} rows ${passes[0]?.rows ?? 0}`,
      );
    }
    if (result.floor) {
      const floor = result.floor;
      console.log(
        `floor cursor+decode ${floor.cursor.ms.toFixed(1)}  cursor count ${floor.cursorCount.ms.toFixed(1)}  rows ${floor.cursor.rows} bytes ${floor.cursor.bytes} (median of ${floor.rounds})`,
      );
      console.log(
        `floor getAll total ${floor.getAll.ms.toFixed(1)} idb ${floor.getAll.idbMs.toFixed(1)} decode ${floor.getAll.decodeMs.toFixed(1)} rows ${floor.getAll.rows} bytes ${floor.getAll.bytes} (median of ${floor.rounds})`,
      );
      console.log(
        `floor one blob get ${floor.oneBlobMs.toFixed(1)} ms for ${floor.cursor.bytes} bytes (median of 5, separate database)`,
      );
    }
  }
}

async function waitForVite(port: number): Promise<void> {
  const deadline = Date.now() + 60_000;
  let last = "vite not up";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/bench/open.html`);
      if (res.ok) return;
      last = `status ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await sleep(200);
  }
  throw new Error(last);
}

async function main(): Promise<number> {
  const load = os.loadavg().map((n) => n.toFixed(2)).join(",");
  console.log(`cores=${os.cpus().length} load=${load}`);
  const port = await freePort();
  const debugPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "wal-open-bench-"));
  const pageUrl =
    `http://127.0.0.1:${port}/bench/open.html?auto=1&runs=${runs}` +
    `&cases=${encodeURIComponent(cases)}&valueBytes=${valueBytes}&docs=${docs}`;
  const vite = spawn(
    "pnpm",
    ["exec", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd: exampleDir, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  vite.unref();
  let viteLog = "";
  vite.stdout?.on("data", (chunk: Buffer) => {
    viteLog += chunk.toString();
  });
  vite.stderr?.on("data", (chunk: Buffer) => {
    viteLog += chunk.toString();
  });
  const chrome = spawn(
    chromePath(),
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-dev-shm-usage",
      "--enable-features=FileSystemAccessAPI",
      "--remote-allow-origins=*",
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${debugPort}`,
      pageUrl,
    ],
    { detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  chrome.unref();
  let chromeLog = "";
  chrome.stderr?.on("data", (chunk: Buffer) => {
    chromeLog += chunk.toString();
  });

  const deadline = Date.now() + timeoutMs;
  let lastStatus = "";
  try {
    await waitForVite(port);
    console.log(`url ${pageUrl}`);
    while (Date.now() < deadline) {
      let socket: string;
      try {
        socket = await pageSocket(debugPort, `http://127.0.0.1:${port}/bench/open.html`);
      } catch (err) {
        lastStatus = err instanceof Error ? err.message : String(err);
        await sleep(500);
        continue;
      }
      let status = "";
      let result: Published | { error: string } | null = null;
      try {
        status = (await devtoolsCall(socket, "Runtime.evaluate", {
          expression: "window.__BENCH_STATUS ?? ''",
          returnByValue: true,
        })) as string;
        result = (await devtoolsCall(socket, "Runtime.evaluate", {
          expression: "window.__BENCH ?? null",
          returnByValue: true,
        })) as Published | { error: string } | null;
      } catch (err) {
        lastStatus = err instanceof Error ? err.message : String(err);
        await sleep(500);
        continue;
      }
      if (status && status !== lastStatus) {
        console.log(status);
        lastStatus = status;
      }
      if (result && "error" in result) {
        console.error(result.error);
        return 1;
      }
      if (result && "results" in result && result.results.length > 0) {
        const last = result.results[result.results.length - 1]!;
        const expected = cases.split(",").filter((id) => id.trim().length > 0).length;
        if (result.results.length === expected && last.floor && last.runs.length >= runs) {
          report(result);
          const out = process.env.BENCH_OUT;
          if (out) fs.writeFileSync(out, JSON.stringify(result, null, 2));
          return 0;
        }
      }
      await sleep(1000);
    }
    console.error(
      `bench timed out after ${timeoutMs}ms\nlast status: ${lastStatus}\nvite:\n${viteLog.slice(-2000)}\nchrome:\n${chromeLog.slice(-2000)}`,
    );
    return 1;
  } finally {
    killProcess(chrome);
    killProcess(vite);
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

process.exitCode = await main();

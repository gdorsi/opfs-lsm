/**
 * Real Chrome over raw CDP: Node's global WebSocket and a handful of CDP
 * methods, no puppeteer. Every lesson from the old harnesses lives here:
 *
 * - a fresh profile per launch, removed on close (isolation between runs)
 * - the debugging port read from <profile>/DevToolsActivePort (no port race)
 * - anti-throttling flags, so background work in a SharedWorker is not slowed
 * - --no-sandbox --disable-dev-shm-usage under CI
 * - never --virtual-time-budget: it starves IndexedDB and OPFS
 * - spawned detached; close() kills the whole process group and waits
 * - results come back as Runtime.evaluate values, never page POSTs, so a
 *   crashed network service cannot drop them
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { MemoryPeaks } from "../core/types.ts";
import { chromeMemory, combine, PeakTracker, WASM_HOOK, type HeapSample, type ProcessMemory } from "./memory.ts";

const SAMPLE_MS = 100;
/** How often the OS is asked about the renderers. Rarely, because asking costs them time (see `chromeMemory`). */
const FOOTPRINT_MS = 1000;

const FLAGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--disable-sync",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
  "--disable-features=Translate,MediaRouter,OptimizationHints",
];

export type Tab = {
  /** Evaluate an expression that yields a Promise; resolve with its value. Rejects with the page's error. */
  evaluate<T>(expression: string, timeoutMs: number): Promise<T>;
  close(): Promise<void>;
};

/** Current values, for probes. */
export type MemoryNow = {
  /** OS memory per Chrome process. Spare renderers come and go, so read the large ones, not the sum. */
  processes: ProcessMemory[];
  sharedWorker: HeapSample | null;
  tab: HeapSample | null;
};

export type Chrome = {
  readonly version: string;
  /** The fresh user-data dir; OPFS files live under it, so its size shows what reached disk. */
  readonly profile: string;
  /** Memory right now, not the peak since launch. */
  now(): Promise<MemoryNow>;
  /** `HeapProfiler.collectGarbage` in every SharedWorker and tab. */
  collectGarbage(): Promise<void>;
  openTab(url: string): Promise<Tab>;
  /** Peaks since launch: SharedWorker and tab JS heap, wasm memory, largest renderer process. Takes one last sample first. */
  memory(): Promise<MemoryPeaks>;
  /** Resolves once no shared_worker target is alive. */
  sharedWorkersGone(timeoutMs: number): Promise<void>;
  /** Kill the process group, wait for exit, delete the profile. Idempotent. */
  close(): Promise<void>;
};

function findChrome(): string {
  const env = process.env.CHROME_PATH;
  if (env) {
    if (!existsSync(env)) throw new Error(`CHROME_PATH does not exist: ${env}`);
    return env;
  }
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(mac)) return mac;
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const found = spawnSync("which", [name], { encoding: "utf8" });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  throw new Error("Chrome not found: set CHROME_PATH");
}

export async function launchChrome(opts: { headless: boolean; onProgress: (line: string) => void }): Promise<Chrome> {
  const profile = mkdtempSync(path.join(tmpdir(), "opfs-lsm-bench-"));
  const args = [
    ...FLAGS,
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    ...(opts.headless ? ["--headless=new"] : []),
    ...(process.env.CI ? ["--no-sandbox", "--disable-dev-shm-usage"] : []),
    "about:blank",
  ];
  const child = spawn(findChrome(), args, { detached: true, stdio: ["ignore", "ignore", "pipe"] });
  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4000);
  });

  let closed = false;
  let stopSampler = () => {};
  const close = async () => {
    if (closed) return;
    closed = true;
    stopSampler();
    await killGroup(child);
    rmSync(profile, { recursive: true, force: true });
  };

  try {
    const port = await readPort(profile, child, () => stderrTail);
    const info = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as {
      webSocketDebuggerUrl: string;
      Browser: string;
    };
    const cdp = await connect(info.webSocketDebuggerUrl);
    const workers = new Set<string>();
    cdp.on("Target.targetCreated", (p) => {
      const t = (p as { targetInfo: { targetId: string; type: string } }).targetInfo;
      if (t.type === "shared_worker") workers.add(t.targetId);
    });
    cdp.on("Target.targetDestroyed", (p) => workers.delete((p as { targetId: string }).targetId));
    cdp.on("Runtime.bindingCalled", (p) => {
      const b = p as { name: string; payload: string };
      if (b.name === "__benchProgress") opts.onProgress(b.payload);
    });
    await cdp.send("Target.setDiscoverTargets", { discover: true });

    const sw = new PeakTracker();
    const tabs = new PeakTracker();
    const workerSessions = new Set<string>();
    const tabSessions = new Set<string>();
    let footprintPeak: number | null = null;
    // Paused at start, so the hook is in place before kv's module script instantiates wasm.
    cdp.on("Target.attachedToTarget", (p) => {
      const a = p as { sessionId: string; targetInfo: { type: string }; waitingForDebugger: boolean };
      if (a.targetInfo.type !== "shared_worker") return;
      workerSessions.add(a.sessionId);
      void (async () => {
        await cdp.send("Runtime.evaluate", { expression: WASM_HOOK }, a.sessionId);
        if (a.waitingForDebugger) await cdp.send("Runtime.runIfWaitingForDebugger", {}, a.sessionId);
      })().catch(() => workerSessions.delete(a.sessionId));
    });
    cdp.on("Target.detachedFromTarget", (p) => workerSessions.delete((p as { sessionId: string }).sessionId));
    await cdp.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [{ type: "shared_worker" }, { exclude: true }],
    });

    const sampleHeap = async (sessionId: string, into: PeakTracker) => {
      const heap = await cdp.send<HeapSample>("Runtime.getHeapUsage", {}, sessionId);
      into.addHeap(heap);
      const wasm = await cdp.send<EvalReply>(
        "Runtime.evaluate",
        { expression: "globalThis.__benchWasm?.() ?? 0", returnByValue: true },
        sessionId,
      );
      if (typeof wasm.result.value === "number") into.addWasm(wasm.result.value);
    };
    const sampleFootprint = async () => {
      const renderers = (await chromeMemory(profile)).filter((p) => p.type === "renderer");
      footprintPeak = Math.max(footprintPeak ?? 0, ...renderers.map((p) => p.peakBytes ?? p.bytes));
    };
    let footprintAt = 0;
    // One sample in flight per session: a worker busy in a synchronous merge answers late, and queued requests would pile up.
    const busy = new Set<string>();
    const sampleAll = async (last = false) => {
      const jobs: Promise<unknown>[] = [];
      const add = (key: string, job: () => Promise<unknown>) => {
        if (busy.has(key)) return;
        busy.add(key);
        jobs.push(job().catch(() => {}).finally(() => busy.delete(key)));
      };
      for (const id of workerSessions) add(id, () => sampleHeap(id, sw));
      for (const id of tabSessions) add(id, () => sampleHeap(id, tabs));
      if (last || Date.now() - footprintAt >= FOOTPRINT_MS) {
        footprintAt = Date.now();
        add("footprint", sampleFootprint);
      }
      await Promise.all(jobs);
    };
    const sampler = setInterval(() => void sampleAll(), SAMPLE_MS);
    sampler.unref();
    stopSampler = () => clearInterval(sampler);

    return {
      version: info.Browser,
      profile,
      async now() {
        const heap = (ids: Set<string>) => {
          const [id] = ids;
          return id ? cdp.send<HeapSample>("Runtime.getHeapUsage", {}, id) : Promise.resolve(null);
        };
        return { processes: await chromeMemory(profile), sharedWorker: await heap(workerSessions), tab: await heap(tabSessions) };
      },
      async collectGarbage() {
        for (const id of [...workerSessions, ...tabSessions]) await cdp.send("HeapProfiler.collectGarbage", {}, id);
      },
      async memory() {
        await sampleAll(true);
        return combine(sw, tabs, footprintPeak);
      },
      async openTab(url) {
        const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
        const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
        await cdp.send("Runtime.enable", {}, sessionId);
        await cdp.send("Page.enable", {}, sessionId);
        await cdp.send("Runtime.addBinding", { name: "__benchProgress" }, sessionId);
        await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: WASM_HOOK }, sessionId);
        tabSessions.add(sessionId);
        const loaded = cdp.once("Page.loadEventFired", sessionId);
        await cdp.send("Page.navigate", { url }, sessionId);
        await withTimeout(loaded, 30_000, "page load");
        return {
          async evaluate<T>(expression: string, timeoutMs: number): Promise<T> {
            const reply = await withTimeout(
              cdp.send<EvalReply>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId),
              timeoutMs,
              `evaluate ${expression.slice(0, 60)}`,
            );
            if (reply.exceptionDetails) {
              const ex = reply.exceptionDetails;
              throw new Error(ex.exception?.description ?? ex.exception?.value ?? ex.text);
            }
            return reply.result.value as T;
          },
          async close() {
            tabSessions.delete(sessionId);
            await cdp.send("Target.closeTarget", { targetId });
          },
        };
      },
      async sharedWorkersGone(timeoutMs) {
        const until = Date.now() + timeoutMs;
        while (workers.size > 0) {
          if (Date.now() > until) throw new Error(`SharedWorker still alive after ${timeoutMs} ms`);
          await sleep(20);
        }
      },
      close,
    };
  } catch (e) {
    await close();
    throw e;
  }
}

type EvalReply = {
  result: { value?: unknown };
  exceptionDetails?: { text: string; exception?: { description?: string; value?: string } };
};

async function readPort(profile: string, child: ChildProcess, tail: () => string): Promise<number> {
  const file = path.join(profile, "DevToolsActivePort");
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`Chrome exited (${child.exitCode}):\n${tail()}`);
    if (existsSync(file)) {
      const port = Number(readFileSync(file, "utf8").split("\n")[0]);
      if (port > 0) return port;
    }
    await sleep(25);
  }
  throw new Error(`Chrome did not open a debugging port:\n${tail()}`);
}

type Listener = (params: unknown, sessionId?: string) => void;

type Cdp = {
  send<T = unknown>(method: string, params?: object, sessionId?: string): Promise<T>;
  on(event: string, listener: Listener): void;
  once(event: string, sessionId: string): Promise<unknown>;
};

async function connect(url: string): Promise<Cdp> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error(`CDP connect failed: ${url}`));
  });
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const listeners = new Map<string, Set<Listener>>();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as {
      id?: number;
      result?: unknown;
      error?: { message: string };
      method?: string;
      params?: unknown;
      sessionId?: string;
    };
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(msg.error.message));
      else p?.resolve(msg.result);
    } else if (msg.method) {
      for (const l of listeners.get(msg.method) ?? []) l(msg.params, msg.sessionId);
    }
  };
  ws.onclose = () => {
    for (const p of pending.values()) p.reject(new Error("CDP connection closed (Chrome crashed?)"));
    pending.clear();
  };
  const on = (event: string, listener: Listener) => {
    let set = listeners.get(event);
    if (!set) listeners.set(event, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  };
  return {
    send<T>(method: string, params: object = {}, sessionId?: string) {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      return new Promise<T>((resolve, reject) => pending.set(id, { resolve: resolve as (v: unknown) => void, reject }));
    },
    on(event, listener) {
      on(event, listener);
    },
    once(event, sessionId) {
      return new Promise((resolve) => {
        const off = on(event, (params, sid) => {
          if (sid !== sessionId) return;
          off();
          resolve(params);
        });
      });
    },
  };
}

async function killGroup(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
  await Promise.race([exited, sleep(5_000)]);
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms: ${what}`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

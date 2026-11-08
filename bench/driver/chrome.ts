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

export type Chrome = {
  readonly version: string;
  openTab(url: string): Promise<Tab>;
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
  const close = async () => {
    if (closed) return;
    closed = true;
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

    return {
      version: info.Browser,
      async openTab(url) {
        const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
        const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
        await cdp.send("Runtime.enable", {}, sessionId);
        await cdp.send("Page.enable", {}, sessionId);
        await cdp.send("Runtime.addBinding", { name: "__benchProgress" }, sessionId);
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

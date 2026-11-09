/**
 * Kill real Chrome under a write workload, relaunch it on the same
 * profile, and check that every acked write survived and nothing is
 * corrupt (docs/research/corruption-hardening-test-suite.md, technique 6).
 *
 *   pnpm --filter @opfs-lsm/kv kill-chrome                      # 20 iterations, random seed
 *   pnpm --filter @opfs-lsm/kv kill-chrome --minutes 30
 *   pnpm --filter @opfs-lsm/kv kill-chrome --seed 7 --iterations 50 --kinds page-crash,kill-browser
 *   pnpm --filter @opfs-lsm/kv kill-chrome --seed 7 --from 12 --iterations 1   # replay one iteration
 *   pnpm --filter @opfs-lsm/kv kill-chrome --probes-only
 *   pnpm --filter @opfs-lsm/kv kill-chrome --inspect <db> --profile <dir> --port <port> [--match <regex>]
 *
 * Each iteration opens 2 or 3 tabs on one database. Every tab runs a
 * seeded write workload with a small `maxWalBytes`, so the SharedWorker
 * ingests and compacts all the time, and reports each ack (tab and
 * attempt) over a CDP binding the moment it resolves. At a seeded time the
 * harness kills one thing:
 *
 *   page-crash      Page.crash on one tab
 *   close-worker    Target.closeTarget on the SharedWorker
 *   kill-renderer   kill -9 of one renderer process
 *   kill-browser    kill -9 of the browser process
 *   browser-crash   Browser.crash
 *   quota           Storage.overrideQuotaForOrigin just above the usage
 *
 * When the browser survives, the other tabs stop and close, and every
 * opfs-lsm Web Lock must be free. Then Chrome is relaunched on the same
 * profile, a fresh tab opens the database (recovery), runs `checkDatabase`
 * under the ingest and compaction locks, and reads every key. A process
 * kill of a tab or of the SharedWorker is not a power loss, so the
 * stronger level holds even though the log is flushed lazily: an ack means
 * the write is in the tab's log file, and the OS keeps those bytes. Every
 * acked write must be in the database (no key shows a value older than an
 * acked write of the same tab), each tab's surviving writes are a prefix
 * of its own order (at most the attempts in flight past its last ack), and
 * the head covers every ack. When the browser process dies (`kill-browser`,
 * `browser-crash`), Chrome can lose a log's unflushed tail, so only
 * consistency is held there: each tab keeps a prefix of its writes, and
 * acked writes lost are reported as notes.
 * Last, the tab writes, ingests through the restarted SharedWorker, and
 * checks the files again.
 *
 * Before the loop, four probes check the platform facts directly: Web
 * Locks of a crashed tab and of a closed SharedWorker are released, the
 * SharedWorker restarts, and a tab or browser killed mid-`createWritable`
 * leaves the target file as it was.
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import ts from "typescript";
import { allKeys, attempts, mix, prng, type WorkOp } from "../proof/kill-chrome-workload.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const KINDS = ["page-crash", "close-worker", "kill-renderer", "kill-browser", "browser-crash", "quota"] as const;
type Kind = (typeof KINDS)[number];

// --- Options.

type Options = {
  seed: number;
  iterations: number;
  minutes: number;
  from: number;
  kinds: Kind[];
  rotate: number;
  keepGoing: boolean;
  probes: boolean;
  probesOnly: boolean;
  verbose: boolean;
  artifacts: string;
  /** Dump the files of this database in a kept profile, then exit. */
  inspect: string | undefined;
  profile: string | undefined;
  port: number;
  match: string;
};

function usage(msg: string): never {
  console.error(msg);
  console.error(
    "usage: kill-chrome [--seed N] [--iterations N] [--minutes M] [--from I] [--kinds a,b] [--rotate N] [--keep-going] [--no-probes] [--probes-only] [--verbose] [--artifacts DIR]",
  );
  process.exit(2);
}

function parseOptions(argv: string[]): Options {
  const opts: Options = {
    seed: Math.floor(Math.random() * 2 ** 31),
    iterations: Number.POSITIVE_INFINITY,
    minutes: Number.POSITIVE_INFINITY,
    from: 0,
    kinds: [...KINDS],
    rotate: 8,
    keepGoing: false,
    probes: true,
    probesOnly: false,
    verbose: process.env.KILL_CHROME_VERBOSE === "1",
    artifacts: path.join(os.tmpdir(), "opfs-kill-chrome"),
    inspect: undefined,
    profile: undefined,
    port: 0,
    match: "^~",
  };
  let bounded = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => argv[++i] ?? usage(`${a} needs a value`);
    const int = () => {
      const n = Number(next());
      if (!Number.isInteger(n) || n < 0) usage(`${a} needs a non-negative integer`);
      return n;
    };
    if (a === "--") continue;
    else if (a === "--seed") opts.seed = int();
    else if (a === "--iterations") {
      opts.iterations = int();
      bounded = true;
    } else if (a === "--minutes") {
      opts.minutes = Number(next());
      bounded = true;
    }
    else if (a === "--from") opts.from = int();
    else if (a === "--rotate") opts.rotate = Math.max(1, int());
    else if (a === "--keep-going") opts.keepGoing = true;
    else if (a === "--no-probes") opts.probes = false;
    else if (a === "--probes-only") opts.probesOnly = true;
    else if (a === "--verbose") opts.verbose = true;
    else if (a === "--artifacts") opts.artifacts = path.resolve(next());
    else if (a === "--inspect") opts.inspect = next();
    else if (a === "--profile") opts.profile = path.resolve(next());
    else if (a === "--port") opts.port = int();
    else if (a === "--match") opts.match = next();
    else if (a === "--kinds") {
      const kinds = next().split(",");
      for (const k of kinds) if (!(KINDS as readonly string[]).includes(k)) usage(`unknown kind ${k}`);
      opts.kinds = kinds as Kind[];
    } else usage(`unknown argument ${a}`);
  }
  if (!Number.isFinite(opts.minutes) && !bounded) opts.iterations = 20;
  if (Number.isNaN(opts.minutes) || opts.minutes <= 0) usage("--minutes needs a positive number");
  return opts;
}

// --- Static server: the page, the engine (`/src/*.js` from dist), and the
// checker (`/tests/sim/*.js` transpiled from TypeScript).

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json",
};

function transpile(file: string): string {
  return ts.transpileModule(fs.readFileSync(file, "utf8"), {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

function resolveFile(urlPath: string): { file: string; ts: boolean } | null {
  const clean = path.posix.normalize(decodeURIComponent(urlPath));
  if (clean.includes("..")) return null;
  if (clean.startsWith("/src/")) return { file: path.join(root, "dist", clean.slice(5)), ts: false };
  if (!/^\/(proof|tests|wasm)\//.test(clean)) return null;
  const file = path.join(root, clean);
  if (fs.existsSync(file) && !file.endsWith(".ts")) return { file, ts: false };
  const tsFile = file.replace(/\.(js|ts)$/, ".ts");
  if (fs.existsSync(tsFile)) return { file: tsFile, ts: true };
  return null;
}

async function startServer(port = 0): Promise<{ server: http.Server; origin: string }> {
  const server = http.createServer((req, res) => {
    const urlPath = (req.url ?? "/").split("?")[0] ?? "/";
    const hit = resolveFile(urlPath);
    if (!hit || !fs.existsSync(hit.file)) {
      res.writeHead(404);
      res.end(`missing ${urlPath}`);
      return;
    }
    const body = hit.ts ? transpile(hit.file) : fs.readFileSync(hit.file);
    const ext = hit.ts ? ".js" : path.extname(hit.file);
    res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("expected a TCP address");
  return { server, origin: `http://127.0.0.1:${addr.port}` };
}

// --- CDP over the browser WebSocket, with flattened sessions.

type CdpMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
  sessionId?: string;
};

class Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Set<(msg: CdpMessage) => void>();
  closed = false;
  private readonly ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as CdpMessage;
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? "cdp error"));
        else p.resolve(msg.result ?? {});
        return;
      }
      for (const fn of this.listeners) fn(msg);
    });
    ws.addEventListener("close", () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error("cdp socket closed"));
      this.pending.clear();
    });
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => resolve(new Cdp(ws)), { once: true });
      ws.addEventListener("error", () => reject(new Error("cdp socket error")), { once: true });
    });
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 15_000): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error("cdp socket closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  /** Fire and forget, for commands whose target dies before it answers. */
  fire(method: string, params: Record<string, unknown> = {}, sessionId?: string): void {
    this.send(method, params, sessionId, 5_000).catch(() => undefined);
  }

  on(fn: (msg: CdpMessage) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  waitFor(pred: (msg: CdpMessage) => boolean, timeoutMs: number): Promise<CdpMessage | undefined> {
    return new Promise((resolve) => {
      const off = this.on((msg) => {
        if (!pred(msg)) return;
        off();
        clearTimeout(timer);
        resolve(msg);
      });
      const timer = setTimeout(() => (off(), resolve(undefined)), timeoutMs);
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

// --- Chrome.

function chromePath(): string {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (fs.existsSync(mac)) return mac;
  return "google-chrome";
}

type TargetInfo = { targetId: string; type: string; url: string };

class Browser {
  readonly crashed = new Set<string>();
  readonly destroyed = new Set<string>();
  readonly workers = new Map<string, TargetInfo>();
  private stderr = "";
  exited: Promise<void>;
  alive = true;

  readonly child: ChildProcess;
  readonly cdp: Cdp;

  private constructor(child: ChildProcess, cdp: Cdp, exited: Promise<void>) {
    this.child = child;
    this.cdp = cdp;
    this.exited = exited;
    child.stderr?.on("data", (c: Buffer) => {
      this.stderr = (this.stderr + c.toString()).slice(-8000);
    });
    cdp.on((msg) => {
      const info = (msg.params?.targetInfo ?? {}) as TargetInfo;
      if (msg.method === "Target.targetCrashed") this.crashed.add(String(msg.params?.targetId));
      if (msg.method === "Target.targetDestroyed") {
        const id = String(msg.params?.targetId);
        this.destroyed.add(id);
        this.workers.delete(id);
      }
      if ((msg.method === "Target.targetCreated" || msg.method === "Target.targetInfoChanged") && info.type === "shared_worker") {
        this.workers.set(info.targetId, info);
      }
    });
  }

  get pid(): number {
    return this.child.pid ?? 0;
  }

  stderrTail(): string {
    return this.stderr.slice(-3000);
  }

  static async launch(profile: string, verbose: boolean): Promise<Browser> {
    const args = [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-breakpad",
      "--disable-crash-reporter",
      "--remote-allow-origins=*",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ];
    if (process.env.CI === "true") args.push("--no-sandbox", "--disable-dev-shm-usage");
    // A stale port file from a killed browser must not be read as this one's.
    fs.rmSync(path.join(profile, "DevToolsActivePort"), { force: true });
    const child = spawn(chromePath(), args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
    if (verbose) child.stderr?.on("data", (c: Buffer) => process.stderr.write(c));
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const wsUrl = await devtoolsUrl(profile, child);
    const cdp = await Cdp.connect(wsUrl);
    const browser = new Browser(child, cdp, exited);
    void exited.then(() => {
      browser.alive = false;
    });
    await cdp.send("Target.setDiscoverTargets", { discover: true });
    return browser;
  }

  /** Close Chrome the normal way, and kill it when that hangs. */
  async close(): Promise<{ exited: boolean; killed: string[] }> {
    let exited = !this.alive;
    if (this.alive) {
      this.cdp.fire("Browser.close");
      exited = await Promise.race([this.exited.then(() => true), sleep(10_000).then(() => false)]);
    }
    const killed = await this.drain();
    this.cdp.close();
    return { exited, killed };
  }

  /**
   * Wait for the helpers (the storage service among them) to exit on their
   * own, as they do when the browser process is gone, and SIGKILL only
   * what is left after 10 s. Killing the group at once would kill the
   * storage service mid-write: a kill the iteration did not ask for.
   */
  async drain(): Promise<string[]> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && this.group().length > 0) await sleep(100);
    const left = this.group();
    this.killAll();
    await Promise.race([this.exited, sleep(5_000)]);
    return left;
  }

  /** Processes still in this browser's process group, as "pid type". */
  group(): string[] {
    const out = execFileSync("ps", ["-A", "-o", "pid=,pgid=,command="], { encoding: "utf8" });
    const left: string[] = [];
    for (const line of out.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!m || Number(m[2]) !== this.pid) continue;
      left.push(`${m[1]} ${/--type=(\S+)/.exec(m[3]!)?.[1] ?? "browser"}${/--utility-sub-type=(\S+)/.exec(m[3]!) ? `:${/--utility-sub-type=(\S+)/.exec(m[3]!)![1]}` : ""}`);
    }
    return left;
  }

  /** SIGKILL the whole process group: the browser and its helpers. */
  killAll(): void {
    const pid = this.child.pid;
    if (!pid) return;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }

  /** Renderer processes of this browser: its process group (on Linux they are children of the zygote, not of the browser). */
  renderers(): number[] {
    const out = execFileSync("ps", ["-A", "-o", "pid=,pgid=,command="], { encoding: "utf8" });
    const pids: number[] = [];
    for (const line of out.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!m) continue;
      if (Number(m[2]) === this.pid && m[3]!.includes("--type=renderer")) pids.push(Number(m[1]));
    }
    return pids;
  }

  /** True once `targetId` is no longer listed. */
  async gone(targetId: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (!(await this.targets()).some((t) => t.targetId === targetId)) return true;
      if (Date.now() > deadline) return false;
      await sleep(50);
    }
  }

  async targets(): Promise<TargetInfo[]> {
    const { targetInfos } = (await this.cdp.send("Target.getTargets")) as { targetInfos: TargetInfo[] };
    return targetInfos;
  }
}

async function devtoolsUrl(profile: string, child: ChildProcess): Promise<string> {
  const file = path.join(profile, "DevToolsActivePort");
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`chrome exited with ${child.exitCode} before devtools was ready`);
    try {
      const [port, wsPath] = fs.readFileSync(file, "utf8").split("\n");
      if (port && wsPath) return `ws://127.0.0.1:${port}${wsPath}`;
    } catch {
      /* not written yet */
    }
    await sleep(50);
  }
  throw new Error("devtools not ready after 20s");
}

// --- Pages.

type Ack = { tab: number; n: number };
type IngestNow = { ok: boolean; generation: number | null; error: { name: string; message: string; typed: boolean } | null };

/** Most `.crswap` files seen in one database directory after a check. */
const swapFiles = { max: 0 };

/** Errors `ingest()` gave under an OPFS quota, across the run. */
const quotaErrors: string[] = [];
type PageError = { tab: number; n: number; name: string; message: string; typed: boolean };

class Page {
  readonly browser: Browser;
  readonly targetId: string;
  readonly sessionId: string;

  private constructor(browser: Browser, targetId: string, sessionId: string) {
    this.browser = browser;
    this.targetId = targetId;
    this.sessionId = sessionId;
  }

  static async open(browser: Browser, url: string, log: (line: string) => void): Promise<Page> {
    const { targetId } = (await browser.cdp.send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
    const { sessionId } = (await browser.cdp.send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
    const page = new Page(browser, targetId, sessionId);
    browser.cdp.on((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params?.exceptionDetails as { exception?: { description?: string }; text?: string } | undefined;
        log(`page exception: ${d?.exception?.description ?? d?.text}`);
      }
      if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
        const args = (msg.params.args as { value?: unknown; description?: string }[]) ?? [];
        log(`console.error: ${args.map((a) => a.value ?? a.description).join(" ")}`);
      }
    });
    await browser.cdp.send("Runtime.enable", {}, sessionId);
    await browser.cdp.send("Runtime.addBinding", { name: "kcAck" }, sessionId);
    await browser.cdp.send("Runtime.addBinding", { name: "kcError" }, sessionId);
    await browser.cdp.send("Page.navigate", { url }, sessionId);
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await page.eval("globalThis.kc?.ready === true", 2_000)) === true) return page;
      } catch {
        /* still navigating */
      }
      if (Date.now() > deadline) throw new Error(`page ${url} did not load`);
      await sleep(50);
    }
  }

  async eval<T = unknown>(expression: string, timeoutMs = 15_000): Promise<T> {
    const res = (await this.browser.cdp.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      this.sessionId,
      timeoutMs,
    )) as { result?: { value?: T }; exceptionDetails?: { exception?: { description?: string }; text?: string } };
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "evaluate failed");
    }
    return res.result?.value as T;
  }

  call<T = unknown>(fn: string, args: unknown[], timeoutMs = 15_000): Promise<T> {
    return this.eval<T>(`kc.${fn}(${args.map((a) => JSON.stringify(a)).join(",")})`, timeoutMs);
  }

  /** Page.crash never answers: the renderer is gone. */
  async crash(): Promise<boolean> {
    const crashed = this.browser.cdp.waitFor(
      (m) => (m.method === "Target.targetCrashed" && m.params?.targetId === this.targetId) || (m.method === "Inspector.targetCrashed" && m.sessionId === this.sessionId),
      5_000,
    );
    this.browser.cdp.fire("Page.crash", {}, this.sessionId);
    return (await crashed) !== undefined;
  }

  get dead(): boolean {
    return this.browser.crashed.has(this.targetId) || this.browser.destroyed.has(this.targetId);
  }

  async close(): Promise<void> {
    await this.browser.cdp.send("Target.closeTarget", { targetId: this.targetId }).catch(() => undefined);
  }
}

// --- The oracle check. A write acks once it is in the tab's log file, so
// every acked write must show in the recovered state. Records have no seq
// the harness can see, and tabs share keys, so the check is per key: the
// value read must come from a write that could be the last one on the key.

type Snapshot = {
  head: number;
  ingestedThrough: number;
  generation: number | null;
  runs: number;
  orphans: number;
  staleManifests: number;
  emptyManifests: number;
  swapFiles: string[];
  problems: string[];
  state: [string, string][];
};

type CheckResult = {
  open: { ok: boolean; error: { name: string; message: string } | null };
  before?: Snapshot;
  range?: [string, string][];
  gets?: Record<string, string | null>;
  restart?: { generationBefore: number; generationAfter: number; probe: string | null; ms: number };
  after?: Snapshot;
  error?: { name: string; message: string };
};

type Write = { tab: number; n: number; op: WorkOp; acked: boolean };

type Verdict = { ok: true } | { ok: false; reason: string; detail: string[] };

/**
 * `perTab[t]` holds tab t's attempts in order: the first `acked` of them
 * were seen acked, the rest may have landed (the acks still in the pipe
 * when the browser died, and the write in flight). Any other value, or an
 * older same-tab value under an acked write, is a lost or invented write.
 */
function verify(
  base: ReadonlyMap<string, string>,
  perTab: readonly { acked: number; attempts: readonly (readonly WorkOp[])[] }[],
  inPlace: { acked: boolean; value: string } | undefined,
  observed: ReadonlyMap<string, string>,
): Verdict {
  const byKey = new Map<string, Write[]>();
  perTab.forEach((t, tab) => {
    t.attempts.forEach((ops, i) => {
      for (const op of ops) {
        const list = byKey.get(op.key) ?? [];
        list.push({ tab, n: i + 1, op, acked: i + 1 <= t.acked });
        byKey.set(op.key, list);
      }
    });
  });
  const detail: string[] = [];
  const bad = (msg: string) => detail.push(msg);
  for (const key of new Set([...base.keys(), ...observed.keys(), ...byKey.keys()])) {
    const got = observed.get(key);
    if (key === "~probe") {
      if (got !== base.get(key)) bad(`${key}: read ${short(got)}, expected ${short(base.get(key))}`);
      continue;
    }
    if (key === "~in-place") {
      const ok = inPlace?.acked ? got === inPlace.value : got === base.get(key) || got === inPlace?.value;
      if (!ok) bad(`${key}: read ${short(got)}, in-place write ${inPlace?.acked ? "acked" : "not acked"}`);
      continue;
    }
    const writes = byKey.get(key) ?? [];
    const ackedWrites = writes.filter((w) => w.acked);
    if (got === undefined) {
      const deleted = writes.some((w) => w.op.type === "del");
      if (!deleted && (base.has(key) || ackedWrites.length > 0)) {
        bad(`${key}: absent, but nothing deleted it (base ${short(base.get(key))}, ${ackedWrites.length} acked writes)`);
      }
      continue;
    }
    if (got === base.get(key)) {
      if (ackedWrites.length > 0) bad(`${key}: still the previous value ${short(got)}, under ${ackedWrites.length} acked writes (tab ${ackedWrites[0]!.tab} attempt ${ackedWrites[0]!.n})`);
      continue;
    }
    const src = writes.find((w) => w.op.type === "put" && w.op.value === got);
    if (!src) {
      bad(`${key}: read ${short(got)}, written by no attempt of this iteration`);
      continue;
    }
    const shadow = ackedWrites.find((w) => w.tab === src.tab && w.n > src.n);
    if (shadow) bad(`${key}: read ${short(got)} (tab ${src.tab} attempt ${src.n}) under that tab's acked attempt ${shadow.n}`);
  }
  return detail.length > 0 ? { ok: false, reason: "state is not what the acked writes allow", detail: detail.slice(0, 12) } : { ok: true };
}

function short(v: string | undefined): string {
  if (v === undefined) return "(none)";
  return v.split("|")[0] ?? v;
}

function sameEntries(a: readonly [string, string][], b: readonly [string, string][]): string | undefined {
  if (a.length !== b.length) return `${a.length} entries vs ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    if (a[i]![0] !== b[i]![0] || a[i]![1] !== b[i]![1]) return `entry ${i}: ${a[i]![0]}=${short(a[i]![1])} vs ${b[i]![0]}=${short(b[i]![1])}`;
  }
  return undefined;
}

// --- One iteration.

type Plan = {
  iteration: number;
  kind: Kind;
  tabs: number;
  maxWalBytes: number;
  killAfterMs: number;
  settleMs: number;
  pick: number;
  quotaSlack: number;
};

function planOf(opts: Options, iteration: number): Plan {
  const rand = prng(mix(opts.seed, iteration, 0x6b696c6c));
  const pick = (n: number) => Math.floor(rand() * n);
  return {
    iteration,
    kind: opts.kinds[iteration % opts.kinds.length]!,
    tabs: 2 + pick(2),
    maxWalBytes: [1024, 4096, 16384][pick(3)]!,
    killAfterMs: 200 + pick(3800),
    settleMs: 100 + pick(1000),
    pick: pick(1 << 20),
    quotaSlack: [-256, -16, 0, 16][pick(4)]! * 1024,
  };
}

type Db = { name: string; base: Map<string, string>; head: number };

type Outcome = {
  ok: boolean;
  line: string;
  failure?: { reason: string; detail: string[] };
  notes: string[];
  stats?: { acked: number; head: number; generation: number | null; runs: number; orphans: number; stale: number };
};

class Run {
  browser: Browser | undefined;
  readonly log: string[] = [];
  /** The database's files at the last few points of interest, for a failure's evidence. */
  readonly snaps: { when: string; files: unknown }[] = [];
  readonly opts: Options;
  readonly origin: string;
  readonly profile: string;

  constructor(opts: Options, origin: string, profile: string) {
    this.opts = opts;
    this.origin = origin;
    this.profile = profile;
  }

  note(line: string): void {
    this.log.push(line);
    if (this.opts.verbose) console.log(`  ${line}`);
  }

  url(): string {
    return `${this.origin}/proof/kill-chrome.html`;
  }

  async launch(): Promise<Browser> {
    if (this.browser?.alive) return this.browser;
    this.browser = await Browser.launch(this.profile, this.opts.verbose);
    return this.browser;
  }

  async page(): Promise<Page> {
    return Page.open(await this.launch(), this.url(), (l) => this.note(l));
  }

  /** Record the database's files (manifests, runs, logs) as `page` sees them now. */
  async snap(page: Page, name: string, when: string): Promise<void> {
    try {
      const files = await page.call<unknown>("inspect", [name, "^~"], 30_000);
      this.snaps.push({ when, files });
    } catch (err) {
      this.snaps.push({ when, files: `inspect failed: ${(err as Error).message}` });
    }
    if (this.snaps.length > 8) this.snaps.shift();
  }

  /** How each graceful close ended: a forced kill here is a kill no iteration asked for. */
  readonly closes: { exited: boolean; killed: string[] }[] = [];

  async closeBrowser(): Promise<void> {
    if (this.browser) {
      const c = await this.browser.close();
      this.closes.push(c);
      if (this.closes.length > 4) this.closes.shift();
      if (!c.exited || c.killed.length > 0) console.log(`     close: browser exited=${c.exited} killed=[${c.killed.join(", ")}]`);
    }
    this.browser = undefined;
  }

  /** After a kill that left Chrome up: every opfs-lsm lock must come free. */
  async locksReleased(page: Page): Promise<string[]> {
    const deadline = Date.now() + 20_000;
    let held: { name: string; mode: string }[] = [];
    while (Date.now() < deadline) {
      const snap = await page.call<{ held: { name: string; mode: string }[] }>("locks", []);
      held = snap.held.filter((l) => l.name.startsWith("opfs-lsm"));
      if (held.length === 0) return [];
      await sleep(100);
    }
    return held.map((l) => `${l.name} (${l.mode})`);
  }

  async iteration(plan: Plan, db: Db): Promise<Outcome> {
    const notes: string[] = [];
    const browser = await this.launch();
    const acks = new Map<number, Set<number>>();
    const errors = new Map<number, PageError>();
    for (let t = 0; t < plan.tabs; t++) acks.set(t, new Set());
    const off = browser.cdp.on((msg) => {
      if (msg.method !== "Runtime.bindingCalled") return;
      const payload = JSON.parse(String(msg.params?.payload));
      if (msg.params?.name === "kcAck") {
        const a = payload as Ack;
        acks.get(a.tab)?.add(a.n);
      } else if (msg.params?.name === "kcError") {
        const e = payload as PageError;
        errors.set(e.tab, e);
      }
    });

    const tabs: Page[] = [];
    for (let t = 0; t < plan.tabs; t++) tabs.push(await this.page());
    await this.snap(tabs[0]!, db.name, `iter ${plan.iteration} after launch, before any tab opens it`);
    await Promise.all(
      tabs.map((p, tab) => p.call("start", [{ name: db.name, seed: this.opts.seed, iteration: plan.iteration, tab, maxWalBytes: plan.maxWalBytes }])),
    );

    // The in-place restart check writes one key: it must be there when
    // its put resolved, and may be there otherwise.
    const inPlaceValue = `in-place ${plan.iteration}|`;
    let inPlaceAcked: boolean | undefined;
    let failure: Outcome["failure"];
    const fail = (reason: string, detail: string[] = []) => {
      failure ??= { reason, detail };
    };

    let browserDies = false;
    let what = "";
    if (plan.kind === "quota") {
      // Chrome 156 applies the override to OPFS writes only, and
      // navigator.storage.estimate() ignores it. Tab log appends and the
      // SharedWorker's ingests both fail under it.
      await sleep(plan.killAfterMs);
      const est = await tabs[0]!.call<{ usage: number; quota: number }>("estimate", []);
      const quotaSize = Math.max(0, est.usage + plan.quotaSlack);
      // The browser session answers "Internal error"; a page session works.
      await browser.cdp.send("Storage.overrideQuotaForOrigin", { origin: this.origin, quotaSize }, tabs[0]!.sessionId);
      what = `quota=${quotaSize} usage=${est.usage}`;
      await sleep(plan.settleMs);
      const under = await tabs[0]!.call<IngestNow>("ingestNow", [], 30_000);
      await browser.cdp.send("Storage.overrideQuotaForOrigin", { origin: this.origin }, tabs[0]!.sessionId);
      // A tab whose log write failed has left (its writes and ingests fail
      // from then on, until the app reopens): ask one whose log did not.
      const failedTabs = new Set([...errors.values()].map((e) => e.tab));
      const healthy = tabs.findIndex((_, t) => !failedTabs.has(t));
      const restored: IngestNow =
        healthy === -1 ? { ok: true, generation: null, error: null } : await tabs[healthy]!.call<IngestNow>("ingestNow", [], 30_000);
      what += ` ingest_under_quota=${under.ok ? "ok" : `${under.error!.typed ? "" : "untyped "}${under.error!.name}`} ingest_after=${healthy === -1 ? "skipped (every log failed)" : restored.ok ? "ok" : restored.error!.name}`;
      if (!under.ok) {
        quotaErrors.push(`${under.error!.typed ? "typed" : "untyped"} ${under.error!.name}: ${under.error!.message.slice(0, 160)}`);
        if (/timed out/.test(under.error!.message)) fail("ingest under quota hung", [under.error!.message]);
      }
      if (!restored.ok) fail("ingest failed after the quota was restored", [`${restored.error!.name}: ${restored.error!.message}`]);
      for (const e of errors.values()) notes.push(`quota: tab ${e.tab} attempt ${e.n} ${e.typed ? "typed" : "untyped"} ${e.name}: ${e.message.slice(0, 120)}`);
    } else {
      await sleep(plan.killAfterMs);
      await this.snap(tabs[0]!, db.name, `iter ${plan.iteration} before ${plan.kind}`);
      if (plan.kind === "page-crash") {
        const victim = tabs[plan.pick % tabs.length]!;
        const ok = await victim.crash();
        what = `tab ${tabs.indexOf(victim)}${ok ? "" : " (no crash event)"}`;
      } else if (plan.kind === "close-worker") {
        const workers = (await browser.targets()).filter((t) => t.type === "shared_worker");
        if (workers.length === 0) {
          what = "no SharedWorker target";
          notes.push("close-worker: no SharedWorker target to close");
        } else {
          const w = workers[0]!;
          const res = await browser.cdp.send("Target.closeTarget", { targetId: w.targetId }).catch((e: Error) => ({ error: e.message }));
          const destroyed = await browser.gone(w.targetId, 5_000);
          what = `worker ${JSON.stringify(res)} destroyed=${destroyed}`;
          if (!destroyed) notes.push(`close-worker: Target.closeTarget did not destroy the SharedWorker (${JSON.stringify(res)})`);
        }
      } else if (plan.kind === "kill-renderer") {
        const pids = browser.renderers();
        const pid = pids[plan.pick % Math.max(1, pids.length)];
        if (pid === undefined) {
          what = "no renderer";
          notes.push("kill-renderer: no renderer process found");
        } else {
          process.kill(pid, "SIGKILL");
          what = `pid ${pid} of ${pids.length}`;
        }
      } else if (plan.kind === "kill-browser") {
        browserDies = true;
        process.kill(browser.pid, "SIGKILL");
        what = `browser pid ${browser.pid}`;
      } else if (plan.kind === "browser-crash") {
        browserDies = true;
        browser.cdp.fire("Browser.crash");
        what = "Browser.crash";
      }
    }

    if (browserDies) {
      const exited = await Promise.race([browser.exited.then(() => true), sleep(15_000).then(() => false)]);
      if (!exited) notes.push("browser did not exit within 15s of the kill");
      const left = await browser.drain();
      if (left.length > 0) notes.push(`helpers still running 10s after the browser died, killed: ${left.join(", ")}`);
      this.browser = undefined;
      browser.cdp.close();
    } else {
      await sleep(plan.settleMs);
      // Survivors finish their write in flight and close their handles.
      const stops = await Promise.all(
        tabs.map(async (p, tab) => {
          if (p.dead) return { tab, dead: true as const };
          try {
            const r = await p.call<{ acked: number; error: unknown }>("stop", [], 30_000);
            return { tab, dead: false as const, r };
          } catch (err) {
            if (p.dead) return { tab, dead: true as const };
            return { tab, dead: false as const, err: (err as Error).message };
          }
        }),
      );
      const dead = stops.filter((s) => s.dead).map((s) => s.tab);
      if (dead.length > 0) what += ` dead tabs [${dead.join(",")}]`;
      for (const s of stops) if ("err" in s && s.err) fail("a surviving tab did not stop", [`tab ${s.tab}: ${s.err}`]);
      const probe = await this.page();
      const held = await this.locksReleased(probe);
      if (held.length > 0) fail("Web Locks still held after the killed context was gone", held);
      // Before any relaunch: a new tab in the same browser must get a
      // SharedWorker that ingests.
      const inPlace = await probe.call<{ ok: boolean; ms: number; acked: boolean; error: string | null }>(
        "restartInPlace",
        [db.name, inPlaceValue],
        40_000,
      );
      inPlaceAcked = inPlace.acked;
      what += ` in_place=${inPlace.ok ? `${inPlace.ms}ms` : "FAILED"}`;
      if (!inPlace.ok) fail("no working SharedWorker in the browser that survived the kill", [String(inPlace.error)]);
      await this.closeBrowser();
    }
    off();

    // Relaunch on the same profile, recover, check.
    let checker: Page;
    try {
      checker = await this.page();
    } catch (err) {
      // Seen once in ~150 browser kills: the relaunched Chrome died at once.
      notes.push(`relaunch failed, retried: ${(err as Error).message}`);
      this.browser?.killAll();
      this.browser = undefined;
      checker = await this.page();
    }
    const probeValue = `probe ${plan.iteration} ${Date.now()}`;
    const keys = [...allKeys(), "~probe", "~in-place"];
    await this.snap(checker, db.name, `iter ${plan.iteration} after relaunch, before the check`);
    const res = await checker.call<CheckResult>("check", [{ name: db.name, keys, probe: probeValue }], 120_000);
    await this.snap(checker, db.name, `iter ${plan.iteration} after the check`);
    const tree = await checker.call<string[]>("opfsTree", []);
    // Chrome leaves a writer's swap file behind when the browser dies mid-write.
    const swaps = tree.filter((p) => p.startsWith(`opfs-lsm/${db.name}/`) && p.includes(".crswap"));
    if (swaps.length > 0) notes.push(`swap files in the database directory: ${swaps.join(", ")}`);
    swapFiles.max = Math.max(swapFiles.max, swaps.length);
    await this.closeBrowser();

    const ackedCount = [...acks.values()].reduce((n, m) => n + m.size, 0);
    if (!res.open.ok) {
      fail("database did not open after the kill", [`${res.open.error?.name}: ${res.open.error?.message}`]);
    } else if (res.error || !res.before || !res.after || !res.range || !res.gets || !res.restart) {
      fail("check failed", [`${res.error?.name}: ${res.error?.message}`]);
    } else {
      const { before, after } = res;
      if (before.problems.length > 0) fail("checkDatabase found problems after recovery", before.problems);
      const observed = new Map(before.state);
      const rangeDiff = sameEntries(res.range, before.state);
      if (rangeDiff) fail("range differs from the files", [rangeDiff]);
      for (const k of keys) {
        if ((res.gets[k] ?? undefined) !== observed.get(k)) {
          fail("get differs from the files", [`${k}: get ${short(res.gets[k] ?? undefined)}, files ${short(observed.get(k))}`]);
          break;
        }
      }
      // Each tab's attempts: the acked ones (a prefix of its order), then as
      // many more as the head has records no ack accounts for: acks can
      // still be in the pipe when the browser dies.
      const moved = before.head - db.head;
      const lower = ackedCount + (inPlaceAcked ? 1 : 0);
      const slack = Math.max(0, moved - lower);
      const perTab: { acked: number; attempts: WorkOp[][] }[] = [];
      for (let t = 0; t < plan.tabs; t++) {
        const tabAcks = acks.get(t)!;
        let acked = 0;
        while (tabAcks.has(acked + 1)) acked++;
        if (tabAcks.size !== acked) fail("acks out of order", [`tab ${t} acked ${[...tabAcks].sort((x, y) => x - y).join(",")}`]);
        const gen = attempts(this.opts.seed, plan.iteration, t);
        const list: WorkOp[][] = [];
        for (let n = 1; n <= acked + slack; n++) list.push(gen.next().value as WorkOp[]);
        perTab.push({ acked, attempts: list });
      }
      // When the browser process dies, Chrome can lose the tail of a log
      // that was written but not flushed (seen with Browser.crash): the
      // design promises consistency there, not every ack. Each tab must
      // still keep a prefix of its writes: every attempt up to the latest
      // one whose value shows must have survived.
      const browserDied = plan.kind === "kill-browser" || plan.kind === "browser-crash";
      if (browserDied) {
        const shown = new Set(observed.values());
        perTab.forEach((t, tab) => {
          let kept = 0;
          t.attempts.forEach((ops, i) => {
            if (ops.some((op) => op.type === "put" && shown.has(op.value))) kept = i + 1;
          });
          if (kept < t.acked) notes.push(`tab ${tab}: kept ${kept} of ${t.acked} acked writes (unflushed tail lost with the browser)`);
          t.acked = kept;
        });
      }
      const inPlace = inPlaceAcked === undefined ? undefined : { acked: inPlaceAcked, value: inPlaceValue };
      const verdict = verify(db.base, perTab, inPlace, observed);
      if (!verdict.ok) fail(verdict.reason, verdict.detail);
      // Every record is one write, so the head covers every ack.
      if (moved < lower && !browserDied) fail("acked write lost: head moved by fewer records than acks", [`${db.head} -> ${before.head}, ${lower} acked`]);
      if (after.problems.length > 0) fail("checkDatabase found problems after the restarted SharedWorker ingested", after.problems);
      const expectAfter = new Map(observed);
      expectAfter.set("~probe", probeValue);
      const afterDiff = sameEntries(after.state, [...expectAfter].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
      if (afterDiff) fail("state changed across the ingest after restart", [afterDiff]);
      if (res.restart.probe !== probeValue) fail("probe write not read back after restart", [String(res.restart.probe)]);
      if (!(res.restart.generationAfter > res.restart.generationBefore)) {
        fail("restarted SharedWorker did not publish a generation", [`${res.restart.generationBefore} -> ${res.restart.generationAfter}`]);
      }
      if (after.head !== before.head + 1) fail("head did not move by one for the probe write", [`${before.head} -> ${after.head}`]);
      if (!failure) {
        db.base = new Map(after.state);
        db.head = after.head;
      }
      return {
        ok: !failure,
        line: `${what} acked=${ackedCount} head=${before.head} gen=${after.generation} runs=${after.runs} orphans=${after.orphans} stale=${after.staleManifests} restart=${res.restart.ms}ms`,
        ...(failure ? { failure } : {}),
        notes,
        stats: { acked: ackedCount, head: before.head, generation: after.generation, runs: after.runs, orphans: after.orphans, stale: after.staleManifests },
      };
    }
    return { ok: false, line: `${what} acked=${ackedCount}`, ...(failure ? { failure } : {}), notes };
  }
}

// --- Probes: the platform facts on their own.

type ProbeResult = { name: string; ok: boolean; detail: string };

async function probes(run: Run): Promise<ProbeResult[]> {
  const out: ProbeResult[] = [];
  const db = `kc-probe-${run.opts.seed}`;
  const attempt = async (name: string, fn: () => Promise<{ ok: boolean; detail: string }>) => {
    try {
      out.push({ name, ...(await fn()) });
    } catch (err) {
      out.push({ name, ok: false, detail: `threw: ${(err as Error).message}` });
    }
    await run.closeBrowser();
    const last = out[out.length - 1]!;
    console.log(`probe ${last.name}: ${last.ok ? "ok" : "FAIL"} ${last.detail}`);
  };

  const lockSet = [
    { name: `opfs-lsm-reclaim/${db}`, mode: "shared" },
    { name: `opfs-lsm:${db}:run:l0/1-1.sst`, mode: "shared" },
    { name: `opfs-lsm-ingest/${db}`, mode: "exclusive" },
  ];

  await attempt("tab-locks", async () => {
    const holder = await run.page();
    const watcher = await run.page();
    await holder.call("holdLocks", [lockSet]);
    const before = await Promise.all(lockSet.map((l) => watcher.call<boolean>("lockFree", [l.name])));
    if (before.some(Boolean)) return { ok: false, detail: "a lock the tab holds reads as free" };
    const crashed = await holder.crash();
    const t0 = Date.now();
    for (;;) {
      const free = await Promise.all(lockSet.map((l) => watcher.call<boolean>("lockFree", [l.name])));
      if (free.every(Boolean)) return { ok: true, detail: `Page.crash crashed=${crashed}; reclaim, run and ingest locks free after ${Date.now() - t0}ms` };
      if (Date.now() - t0 > 10_000) return { ok: false, detail: `still held 10s after Page.crash: ${lockSet.filter((_, i) => !free[i]).map((l) => l.name).join(", ")}` };
      await sleep(50);
    }
  });

  await attempt("worker-locks", async () => {
    const browser = await run.launch();
    const tab = await run.page();
    await tab.call("connect", [db], 30_000);
    let worker: TargetInfo | undefined;
    for (let i = 0; i < 100 && !worker; i++) {
      worker = (await browser.targets()).find((t) => t.type === "shared_worker");
      if (!worker) await sleep(50);
    }
    if (!worker) return { ok: false, detail: "no SharedWorker target after openDb" };
    const { sessionId } = (await browser.cdp.send("Target.attachToTarget", { targetId: worker.targetId, flatten: true })) as { sessionId: string };
    const wanted = lockSet.filter((l) => l.mode === "exclusive").concat([{ name: `opfs-lsm-compact/${db}`, mode: "exclusive" }]);
    const hold = `Promise.all(${JSON.stringify(wanted)}.map((l) => new Promise((ok) => { navigator.locks.request(l.name, { mode: l.mode }, () => { ok(); return new Promise(() => {}); }); }))).then(() => true)`;
    await browser.cdp.send("Runtime.evaluate", { expression: hold, awaitPromise: true, returnByValue: true }, sessionId);
    const watcher = await run.page();
    const before = await Promise.all(wanted.map((l) => watcher.call<boolean>("lockFree", [l.name])));
    if (before.some(Boolean)) return { ok: false, detail: "a lock the SharedWorker holds reads as free" };
    // Detach first: closed while DevTools was attached, the next tab got no working SharedWorker.
    await browser.cdp.send("Target.detachFromTarget", { sessionId });
    const closed = await browser.cdp.send("Target.closeTarget", { targetId: worker.targetId }).catch((e: Error) => ({ error: e.message }));
    // No Target.targetDestroyed arrives for a SharedWorker; the listing is the proof.
    const destroyed = await browser.gone(worker.targetId, 10_000);
    if (!destroyed) return { ok: false, detail: `Target.closeTarget on the SharedWorker returned ${JSON.stringify(closed)} and it is still listed` };
    const t0 = Date.now();
    let free: boolean[] = [];
    for (;;) {
      free = await Promise.all(wanted.map((l) => watcher.call<boolean>("lockFree", [l.name])));
      if (free.every(Boolean)) break;
      if (Date.now() - t0 > 10_000) return { ok: false, detail: `SharedWorker closed, locks still held: ${wanted.filter((_, i) => !free[i]).map((l) => l.name).join(", ")}` };
      await sleep(50);
    }
    const lockMs = Date.now() - t0;
    // A tab that opens the database now must get a SharedWorker that ingests.
    // Tried twice: while the closed worker's old client is still open, and
    // after it closed, since Chrome may keep the worker's slot for it.
    const restart = async (probe: string) => {
      const known = new Set(browser.workers.keys());
      const fresh = await run.page();
      const res = await fresh.call<CheckResult>("check", [{ name: db, keys: [], probe }], 60_000);
      await fresh.close();
      const started = [...browser.workers.keys()].some((id) => !known.has(id) && id !== worker!.targetId);
      const ok = !!res.restart && res.restart.generationAfter > res.restart.generationBefore && res.restart.probe === probe && (res.after?.problems.length ?? 1) === 0;
      return { ok, text: `new SharedWorker ${started ? "listed" : "not listed"}, ingest ${ok ? "ok" : `FAILED (${res.error?.message ?? JSON.stringify(res.after?.problems)})`}` };
    };
    const withClient = await restart("p1");
    await tab.close();
    await watcher.close();
    await sleep(500);
    const withoutClient = await restart("p2");
    return {
      ok: withoutClient.ok,
      detail: `Target.closeTarget ${JSON.stringify(closed)} removed the SharedWorker; its ingest and compaction locks free after ${lockMs}ms; new tab while the old client is open: ${withClient.text}; new tab after the old client closed: ${withoutClient.text}`,
    };
  });

  const A = 0x41;
  const B = 0x42;
  const original = 64 * 1024;
  await attempt("writable-tab-crash", async () => {
    const writer = await run.page();
    await writer.call("writeProbe", ["tab.bin", original, A]);
    await writer.call("writeProbeOpen", ["tab.bin", 8 << 20, B], 30_000);
    await writer.crash();
    const reader = await run.page();
    const got = await reader.call<{ size: number; fills: number[] } | null>("readProbe", ["tab.bin"]);
    const tree = await reader.call<string[]>("opfsTree", []);
    const ok = got?.size === original && got.fills.length === 1 && got.fills[0] === A;
    return { ok, detail: `target after Page.crash mid-write: ${JSON.stringify(got)}; kc-probe entries: ${tree.filter((p) => p.startsWith("kc-probe/")).join(", ")}` };
  });

  await attempt("writable-browser-kill", async () => {
    const browser = await run.launch();
    const writer = await run.page();
    await writer.call("writeProbe", ["browser.bin", original, A]);
    await writer.call("writeProbeOpen", ["browser.bin", 8 << 20, B], 30_000);
    process.kill(browser.pid, "SIGKILL");
    await Promise.race([browser.exited, sleep(10_000)]);
    await browser.drain();
    run.browser = undefined;
    const onDisk = findFiles(run.profile, /crswap/i);
    const reader = await run.page();
    const got = await reader.call<{ size: number; fills: number[] } | null>("readProbe", ["browser.bin"]);
    const tree = await reader.call<string[]>("opfsTree", []);
    const ok = got?.size === original && got.fills.length === 1 && got.fills[0] === A;
    return {
      ok,
      detail: `target after kill -9 of the browser mid-write: ${JSON.stringify(got)}; kc-probe entries after relaunch: ${tree.filter((p) => p.startsWith("kc-probe/")).join(", ")}; profile files named *crswap* before relaunch: ${onDisk.length}`,
    };
  });
  // After a browser kill, Chrome was seen to lose the files a later session
  // created while keeping what it removed: write, kill, then in the next
  // session create one file and remove another, close, and look again.
  await attempt("session-after-browser-kill", async () => {
    let browser = await run.launch();
    let page = await run.page();
    await page.call("writeProbe", ["s-before.bin", original, A]);
    await page.call("writeProbeOpen", ["s-busy.bin", 8 << 20, B], 30_000);
    process.kill(browser.pid, "SIGKILL");
    await Promise.race([browser.exited, sleep(10_000)]);
    await browser.drain();
    run.browser = undefined;
    browser = await run.launch();
    page = await run.page();
    await page.call("writeProbe", ["s-after.bin", original, B]);
    await page.call("removeProbe", ["s-before.bin"]);
    // The engine too: a fresh database written, ingested and checked.
    const sdb = `kc-session-${run.opts.seed}`;
    const res = await page.call<CheckResult>("check", [{ name: sdb, keys: [], probe: "session" }], 60_000);
    const dbIn = await page.call<{ manifests: { file: string }[] }>("inspect", [sdb, "^~"], 30_000);
    const inSession = await page.call<string[]>("opfsTree", []);
    await run.closeBrowser();
    page = await run.page();
    const dbNext = await page.call<{ manifests: { file: string }[] }>("inspect", [sdb, "^~"], 30_000);
    const after = await page.call<{ size: number; fills: number[] } | null>("readProbe", ["s-after.bin"]);
    const before = await page.call<{ size: number; fills: number[] } | null>("readProbe", ["s-before.bin"]);
    const tree = await page.call<string[]>("opfsTree", []);
    return {
      ok: after !== null && before === null && dbNext.manifests.length > 0,
      detail: `created after the kill: ${after ? "kept" : "LOST"}; removed after the kill: ${before ? "BACK" : "stays removed"}; engine db check ${res.open.ok ? "opened" : "failed"}, manifests in that session [${dbIn.manifests.map((m) => m.file).join(",")}], next launch [${dbNext.manifests.map((m) => m.file).join(",")}]; in that session: ${inSession.filter((p) => p.startsWith("kc-probe/s-")).join(", ")}; next launch: ${tree.filter((p) => p.startsWith("kc-probe/s-")).join(", ")}`,
    };
  });
  return out;
}

function findFiles(dir: string, re: RegExp): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (re.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

// --- Main.

function replay(opts: Options, iteration: number): string {
  return `pnpm --filter @opfs-lsm/kv kill-chrome --seed ${opts.seed} --from ${iteration} --iterations 1 --kinds ${opts.kinds.join(",")} --no-probes`;
}

async function main(): Promise<number> {
  const opts = parseOptions(process.argv.slice(2));
  for (const f of ["dist/index.js", "dist/testing.js", "dist/host/shared-worker.js"]) {
    if (!fs.existsSync(path.join(root, f))) {
      console.error(`missing ${f}. Run pnpm --filter @opfs-lsm/kv build`);
      return 1;
    }
  }
  // Storage is per origin, so a kept profile is read back on its own port.
  const { server, origin } = await startServer(opts.port);
  if (opts.inspect) {
    if (!opts.profile || !opts.port) usage("--inspect needs --profile and --port");
    const run = new Run(opts, origin, opts.profile);
    try {
      const page = await run.page();
      console.log(JSON.stringify(await page.call("inspect", [opts.inspect, opts.match], 120_000), null, 1));
    } finally {
      await run.closeBrowser();
      server.close();
    }
    return 0;
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "opfs-kill-chrome-"));
  const run = new Run(opts, origin, profile);
  const started = Date.now();
  const deadline = started + opts.minutes * 60_000;
  console.log(`kill-chrome seed=${opts.seed} kinds=${opts.kinds.join(",")} profile=${profile} origin=${origin}`);

  let failures = 0;
  const counts = new Map<string, { ok: number; fail: number }>();
  const maxOrphans = { n: 0 };
  const cleanup = async () => {
    await run.closeBrowser().catch(() => undefined);
    server.close();
  };
  process.on("SIGINT", () => {
    run.browser?.killAll();
    process.exit(130);
  });

  try {
    if (opts.probes || opts.probesOnly) {
      for (const p of await probes(run)) {
        const c = counts.get(`probe ${p.name}`) ?? { ok: 0, fail: 0 };
        if (p.ok) {
          c.ok++;
        } else {
          c.fail++;
          failures++;
        }
        counts.set(`probe ${p.name}`, c);
      }
      if (failures > 0 && !opts.keepGoing) return 1;
    }
    if (!opts.probesOnly) {
      let epoch = 0;
      let db: Db | undefined;
      for (let i = opts.from; i < opts.from + opts.iterations && Date.now() < deadline; i++) {
        const plan = planOf(opts, i);
        const name = `kc-${opts.seed}-${Math.floor(i / opts.rotate)}-${epoch}`;
        if (db?.name !== name) db = { name, base: new Map(), head: 0 };
        const t0 = Date.now();
        let outcome: Outcome;
        try {
          outcome = await run.iteration(plan, db);
        } catch (err) {
          outcome = { ok: false, line: "harness error", failure: { reason: "harness error", detail: [String((err as Error).stack ?? err)] }, notes: [] };
          run.browser?.killAll();
          run.browser = undefined;
        }
        const c = counts.get(plan.kind) ?? { ok: 0, fail: 0 };
        if (outcome.ok) c.ok++;
        else c.fail++;
        counts.set(plan.kind, c);
        maxOrphans.n = Math.max(maxOrphans.n, outcome.stats?.orphans ?? 0);
        const label = `iter=${i} kind=${plan.kind} tabs=${plan.tabs} wal=${plan.maxWalBytes} kill_at=${plan.killAfterMs}ms`;
        console.log(`${outcome.ok ? "ok  " : "FAIL"} ${label} ${outcome.line} (${Date.now() - t0}ms)`);
        for (const n of outcome.notes) console.log(`     note: ${n}`);
        if (!outcome.ok) {
          failures++;
          // The database's history is no longer known: continue on a fresh one.
          epoch++;
          const f = outcome.failure!;
          fs.mkdirSync(opts.artifacts, { recursive: true });
          const file = path.join(opts.artifacts, `seed-${opts.seed}-iter-${i}.json`);
          fs.writeFileSync(file, JSON.stringify({ seed: opts.seed, plan, db: db.name, failure: f, notes: outcome.notes, log: run.log.slice(-200), snaps: run.snaps, closes: run.closes, chrome: run.browser?.stderrTail() }, null, 2));
          console.log(`     seed=${opts.seed} iteration=${i} kind=${plan.kind} kill_at=${plan.killAfterMs}ms tabs=${plan.tabs} maxWalBytes=${plan.maxWalBytes}`);
          console.log(`     reason: ${f.reason}`);
          for (const d of f.detail) console.log(`       ${d}`);
          console.log(`     evidence: ${file}`);
          console.log(`     replay: ${replay(opts, i)}`);
          if (!opts.keepGoing) break;
        }
        run.log.length = 0;
      }
    }
  } finally {
    await cleanup();
  }

  const minutes = ((Date.now() - started) / 60_000).toFixed(1);
  console.log(`\nkill-chrome seed=${opts.seed} minutes=${minutes} max_orphans=${maxOrphans.n} max_swap_files=${swapFiles.max}`);
  for (const [kind, c] of counts) console.log(`  ${kind.padEnd(28)} ok=${c.ok} fail=${c.fail}`);
  const byError = new Map<string, number>();
  for (const e of quotaErrors) byError.set(e, (byError.get(e) ?? 0) + 1);
  for (const [e, n] of byError) console.log(`  ingest under quota (${n}x): ${e}`);
  if (failures === 0) {
    fs.rmSync(profile, { recursive: true, force: true });
    console.log("kill-chrome ok");
    return 0;
  }
  console.log(`kill-chrome FAILED (${failures}); profile kept at ${profile}`);
  return 1;
}

process.exit(await main());

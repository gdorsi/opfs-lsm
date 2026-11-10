/**
 * Prove the ingest queue writer in real Chrome: `LogClient` and its
 * dedicated WebWorker write segment files to OPFS, and a page reads them
 * back with the real `scanLog` and `planIngest`.
 *
 *   pnpm --filter @opfs-lsm/kv log-queue
 *   LOG_QUEUE_VERBOSE=1 pnpm --filter @opfs-lsm/kv log-queue
 *   LOG_QUEUE_ONLY=stuck pnpm --filter @opfs-lsm/kv log-queue   # one of clean, suspendResume, stuck, crashMidAppend
 *
 * Cases: a clean close reads back exactly; suspend frees the lock and
 * resume starts a log after it; a stuck dedicated WebWorker is terminated
 * and followed by a log whose header names the right pred; Page.crash and
 * kill -9 of the browser mid-append lose no acked write.
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verbose = process.env.LOG_QUEUE_VERBOSE === "1";

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".wasm": "application/wasm" };

function resolveFile(urlPath: string): { file: string; ts: boolean } | null {
  const clean = path.posix.normalize(decodeURIComponent(urlPath));
  if (clean.includes("..")) return null;
  if (clean.startsWith("/src/")) return { file: path.join(root, "dist", clean.slice(5)), ts: false };
  if (!clean.startsWith("/proof/")) return null;
  const file = path.join(root, clean);
  if (fs.existsSync(file) && !file.endsWith(".ts")) return { file, ts: false };
  const tsFile = file.replace(/\.(js|ts)$/, ".ts");
  return fs.existsSync(tsFile) ? { file: tsFile, ts: true } : null;
}

async function startServer(): Promise<{ server: http.Server; origin: string }> {
  const server = http.createServer((req, res) => {
    if (req.url === "/hang") return;
    const hit = resolveFile((req.url ?? "/").split("?")[0] ?? "/");
    if (!hit || !fs.existsSync(hit.file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const body = hit.ts
      ? ts.transpileModule(fs.readFileSync(hit.file, "utf8"), { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText
      : fs.readFileSync(hit.file);
    res.writeHead(200, { "content-type": MIME[hit.ts ? ".js" : path.extname(hit.file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("expected a TCP address");
  return { server, origin: `http://127.0.0.1:${addr.port}` };
}

type CdpMessage = { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message?: string }; sessionId?: string };

class Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Set<(msg: CdpMessage) => void>();

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as CdpMessage;
      const p = msg.id === undefined ? undefined : this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id!);
        if (msg.error) p.reject(new Error(msg.error.message ?? "cdp error"));
        else p.resolve(msg.result ?? {});
      } else for (const fn of this.listeners) fn(msg);
    });
    ws.addEventListener("close", () => {
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

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30_000): Promise<Record<string, unknown>> {
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

  /** For commands whose target never answers. */
  fire(method: string, params: Record<string, unknown>, sessionId?: string): void {
    this.send(method, params, sessionId, 5_000).catch(() => undefined);
  }

  on(fn: (msg: CdpMessage) => void): void {
    this.listeners.add(fn);
  }

  close(): void {
    this.ws.close();
  }
}

function chromePath(): string {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return fs.existsSync(mac) ? mac : "google-chrome";
}

class Browser {
  private constructor(
    readonly child: ChildProcess,
    readonly cdp: Cdp,
    readonly version: string,
  ) {}

  static async launch(profile: string): Promise<Browser> {
    const args = [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-breakpad",
      "--remote-allow-origins=*",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ];
    if (process.env.CI === "true") args.push("--no-sandbox", "--disable-dev-shm-usage");
    fs.rmSync(path.join(profile, "DevToolsActivePort"), { force: true });
    const child = spawn(chromePath(), args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
    if (verbose) child.stderr?.on("data", (c: Buffer) => process.stderr.write(c));
    else child.stderr?.resume();
    child.stdout?.resume();
    const deadline = Date.now() + 20_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`chrome exited with ${child.exitCode}`);
      try {
        const [port, wsPath] = fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n");
        if (port && wsPath) {
          const cdp = await Cdp.connect(`ws://127.0.0.1:${port}${wsPath}`);
          const { product } = (await cdp.send("Browser.getVersion")) as { product: string };
          return new Browser(child, cdp, product);
        }
      } catch {
        /* not written yet */
      }
      if (Date.now() > deadline) throw new Error("devtools not ready after 20s");
      await sleep(50);
    }
  }

  /** kill -9 of the browser process, then of whatever of its group outlives it 10 s. */
  async kill(): Promise<void> {
    const pid = this.child.pid!;
    const exited = new Promise<void>((r) => this.child.once("exit", () => r()));
    process.kill(pid, "SIGKILL");
    await exited;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && this.group().length > 0) await sleep(100);
    this.killGroup();
    this.cdp.close();
  }

  private group(): number[] {
    const out = execFileSync("ps", ["-A", "-o", "pid=,pgid="], { encoding: "utf8" });
    return out
      .split("\n")
      .map((l) => l.trim().split(/\s+/).map(Number))
      .filter(([p, g]) => g === this.child.pid && p !== undefined)
      .map(([p]) => p!);
  }

  killGroup(): void {
    try {
      process.kill(-this.child.pid!, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

type WorkerSession = { sessionId: string; url: string; detached: boolean };

class Page {
  readonly workers: WorkerSession[] = [];

  private constructor(
    readonly browser: Browser,
    readonly targetId: string,
    readonly sessionId: string,
  ) {}

  static async open(browser: Browser, url: string, onAck?: (payload: string) => void): Promise<Page> {
    const { cdp } = browser;
    const { targetId } = (await cdp.send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
    const { sessionId } = (await cdp.send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
    const page = new Page(browser, targetId, sessionId);
    cdp.on((msg) => {
      if (msg.method === "Target.attachedToTarget" && msg.sessionId === sessionId) {
        const p = msg.params as { sessionId: string; targetInfo: { type: string; url: string } };
        if (p.targetInfo.type === "worker") page.workers.push({ sessionId: p.sessionId, url: p.targetInfo.url, detached: false });
      }
      if (msg.method === "Target.detachedFromTarget" && msg.sessionId === sessionId) {
        const w = page.workers.find((x) => x.sessionId === (msg.params as { sessionId: string }).sessionId);
        if (w) w.detached = true;
      }
      if (msg.sessionId !== sessionId) return;
      if (msg.method === "Runtime.bindingCalled" && (msg.params as { name: string }).name === "lqAck") onAck?.((msg.params as { payload: string }).payload);
      if (msg.method === "Runtime.exceptionThrown" && verbose) console.error("page exception", JSON.stringify(msg.params));
    });
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Runtime.addBinding", { name: "lqAck" }, sessionId);
    await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
    await cdp.send("Page.navigate", { url }, sessionId);
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await page.eval("globalThis.lq?.ready === true", 2_000)) === true) return page;
      } catch {
        /* still navigating */
      }
      if (Date.now() > deadline) throw new Error(`page ${url} did not load`);
      await sleep(50);
    }
  }

  async eval<T = unknown>(expression: string, timeoutMs = 30_000): Promise<T> {
    const res = (await this.browser.cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, this.sessionId, timeoutMs)) as {
      result?: { value?: T };
      exceptionDetails?: { exception?: { description?: string }; text?: string };
    };
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "evaluate failed");
    return res.result?.value as T;
  }

  call<T = unknown>(fn: string, ...args: unknown[]): Promise<T> {
    return this.eval<T>(`lq.${fn}(${args.map((a) => JSON.stringify(a)).join(",")})`);
  }

  /**
   * Blocks the log's dedicated WebWorker in native code, as a stuck sync
   * write does: a sync XHR the server never answers. A JS spin is no
   * stand-in: Chrome kept a spinning dedicated WebWorker's lock for over
   * 30 s after terminate() when the spin ran from DevTools.
   */
  blockLogWorker(): void {
    const w = this.workers.filter((x) => !x.detached && x.url.endsWith("/log-worker.js")).at(-1);
    if (!w) throw new Error(`no attached log dedicated WebWorker (workers: ${JSON.stringify(this.workers)})`);
    this.browser.cdp.fire("Runtime.evaluate", { expression: "const x = new XMLHttpRequest(); x.open('GET', '/hang', false); x.send();" }, w.sessionId);
  }

  async crash(): Promise<void> {
    this.browser.cdp.fire("Page.crash", {}, this.sessionId);
    await sleep(500);
  }
}

type Ack = { log: string; n: number; label: string };
type Read = { log: string; dead: boolean; pred: { log: string; lastN: number } | null; stop: unknown; segments: number; records: { n: number; label: string }[] };

class Check {
  failures: string[] = [];
  constructor(private readonly name: string) {}
  that(ok: boolean, what: string, detail: unknown = ""): void {
    if (!ok) this.failures.push(`${what}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
  }
  report(lines: string[]): boolean {
    console.log(`\n## ${this.name}`);
    for (const l of lines) console.log(l);
    for (const f of this.failures) console.log(`FAIL ${f}`);
    console.log(this.failures.length === 0 ? `${this.name} ok` : `${this.name} FAILED`);
    return this.failures.length === 0;
  }
}

const sameRecords = (read: Read, labels: string[]): boolean =>
  read.records.length === labels.length && read.records.every((r, i) => r.n === i + 1 && r.label === labels[i]);

async function clean(browser: Browser, origin: string): Promise<boolean> {
  const c = new Check("clean close");
  const db = "lq-clean";
  const page = await Page.open(browser, `${origin}/proof/log-queue.html`);
  await page.call("start", db, 4096);
  const first = await page.call<Ack[]>("appendMany", "c", 300, 7, 600);
  const log = first[0]!.log;
  c.that(first.every((a, i) => a.log === log && a.n === i + 1), "acks are 1..300 in call order in one log");
  c.that(await page.call<boolean>("lockHeld", db, log), "the log's lock is held while it is live");
  await page.call("rotate");
  const more = await page.call<Ack[]>("appendMany", "d", 10, 3, 600);
  await page.call("flush");
  const { durable } = await page.call<{ durable: [string, number][] }>("events");
  c.that(durable.at(-1)?.[0] === log && durable.at(-1)?.[1] === 310, "flush reports durable n = 310", durable.at(-1));
  await page.call("close");
  c.that(!(await page.call<boolean>("lockHeld", db, log)), "the lock is free after close");
  const read = await page.call<Read>("read", db, log);
  const labels = [...first, ...more].map((a) => a.label);
  c.that(read.dead, "the closed log reads as dead");
  c.that(read.stop === "end", "the scan ends at the log's end", read.stop);
  c.that(read.pred === null, "the first log has no pred", read.pred);
  c.that(sameRecords(read, labels), "scanLog reads back exactly the 310 acked records in order", read.records.length);
  c.that(read.segments > 2, "segments rotated", read.segments);
  return c.report([`log=${log} records=${read.records.length} segments=${read.segments} durable_reports=${durable.length}`]);
}

async function suspendResume(browser: Browser, origin: string): Promise<boolean> {
  const c = new Check("suspend and resume");
  const db = "lq-suspend";
  const page = await Page.open(browser, `${origin}/proof/log-queue.html`);
  await page.call("start", db, 1 << 20);
  const before = await page.call<Ack[]>("appendMany", "s", 5, 2, 64);
  const old = before[0]!.log;
  await page.call("suspend");
  c.that(!(await page.call<boolean>("lockHeld", db, old)), "suspend frees the log's lock");
  await page.eval("void (globalThis.waited = lq.appendMany('t', 3, 3, 64))");
  await page.call("resume");
  const after = await page.eval<Ack[]>("globalThis.waited");
  const fresh = after[0]!.log;
  c.that(fresh !== old && after.every((a, i) => a.log === fresh && a.n === i + 1), "appends made while suspended land as 1..3 of a new log", after);
  const { respawned } = await page.call<{ respawned: [string, { log: string; lastN: number }][] }>("events");
  c.that(JSON.stringify(respawned) === JSON.stringify([[fresh, { log: old, lastN: 5 }]]), "respawned reports the new log with pred { old, 5 }", respawned);
  await page.call("close");
  const next = await page.call<Read>("read", db, fresh);
  c.that(next.pred?.log === old && next.pred.lastN === 5, "the new log's first header names pred { old, 5 }", next.pred);
  const applied = await page.call<{ live: string[]; labels: string[] }>("applied", db);
  const labels = [...before, ...after].map((a) => a.label);
  c.that(applied.live.length === 0 && JSON.stringify(applied.labels) === JSON.stringify(labels), "planIngest orders both logs as the page called them", applied);
  return c.report([`old=${old} new=${fresh} pred=${JSON.stringify(next.pred)}`]);
}

async function stuck(browser: Browser, origin: string): Promise<boolean> {
  const c = new Check("stuck dedicated WebWorker");
  const db = "lq-stuck";
  const page = await Page.open(browser, `${origin}/proof/log-queue.html`);
  await page.call("start", db, 1 << 20);
  const before = await page.call<Ack[]>("appendMany", "w", 5, 1, 64);
  const old = before[0]!.log;
  await page.call("flush");
  page.blockLogWorker();
  const late = await page.call<{ ok: boolean; error: string | null; ms: number }>("appendOne", "w-6");
  c.that(!late.ok && late.error === "IndeterminateWriteError", "a write to the stuck dedicated WebWorker rejects as indeterminate", late);
  c.that(late.ms >= 10_000 && late.ms < 11_000, "after 10 s", late.ms);
  const freeMs = await page.call<number>("lockFreeAfter", db, old, 10_000);
  c.that(freeMs >= 0, "the stuck log's lock is free after the dedicated WebWorker is terminated", freeMs);
  const after = await page.call<Ack[]>("appendMany", "x", 3, 1, 64);
  const fresh = after[0]!.log;
  c.that(fresh !== old && after.every((a, i) => a.log === fresh && a.n === i + 1), "later appends land as 1..3 of a new log", after);
  const { respawned } = await page.call<{ respawned: [string, { log: string; lastN: number }][] }>("events");
  c.that(JSON.stringify(respawned) === JSON.stringify([[fresh, { log: old, lastN: 5 }]]), "respawned reports pred { old, 5 }", respawned);
  const next = await page.call<Read>("read", db, fresh);
  c.that(next.pred?.log === old && next.pred.lastN === 5, "the new log's first header names pred { old, 5 }", next.pred);
  await page.call("close");
  const prev = await page.call<Read>("read", db, old);
  const landed = prev.records.slice(5).map((r) => r.label);
  c.that(prev.dead, "the stuck log reads as dead");
  c.that(JSON.stringify(prev.records.slice(0, 5).map((r) => r.label)) === JSON.stringify(before.map((a) => a.label)), "the stuck log holds its 5 acked records first", prev.records);
  c.that(landed.every((l) => l === "w-6"), "past them, at most the indeterminate write", landed);
  const applied = await page.call<{ live: string[]; labels: string[] }>("applied", db);
  const labels = [...before, ...after].map((a) => a.label);
  const at6 = applied.labels.indexOf("w-6");
  c.that(JSON.stringify(applied.labels.filter((l) => l !== "w-6")) === JSON.stringify(labels), "planIngest orders the stuck log's acked records before its successor's", applied.labels);
  c.that(at6 < 0 || at6 < applied.labels.indexOf("x-1"), "the indeterminate write is never ingested after a later write", applied.labels);
  return c.report([`old=${old} new=${fresh} indeterminate_after_ms=${late.ms} lock_free_after_ms=${freeMs} late_write_landed=${landed.length > 0} late_write_ingested=${at6 >= 0}`]);
}

/**
 * Every ack the harness saw is in the log at its n with its label, and the
 * log is a gapless prefix. How the reader classifies the end is printed,
 * not checked: a kill between a SEAL and its successor's creation reads as
 * a hole on this base (queue-writer.ts seals first), and that is the
 * reader's and writer's contract, not this client's.
 */
function checkAcked(c: Check, acks: Ack[], read: Read): string {
  const byN = new Map(read.records.map((r) => [r.n, r.label]));
  const lost = acks.filter((a) => byN.get(a.n) !== a.label);
  c.that(acks.length > 0, "the harness saw acks before the kill");
  c.that(lost.length === 0, "every acked write is on disk at its n", lost.slice(0, 5));
  c.that(read.records.every((r, i) => r.n === i + 1), "the records read back are 1..m with no gap");
  return read.stop === "end" ? "stop=end" : `stop=${JSON.stringify(read.stop)} NOTE: the reader calls this dead log's end damage`;
}

async function crashMidAppend(browser: Browser, origin: string): Promise<boolean> {
  const c = new Check("Page.crash mid-append");
  const db = "lq-crash";
  const acks: Ack[] = [];
  const page = await Page.open(browser, `${origin}/proof/log-queue.html`, (p) => acks.push(JSON.parse(p) as Ack));
  await page.call("start", db, 8192);
  await page.call("flood", "k", 900);
  const deadline = Date.now() + 10_000;
  while (acks.length < 2000 && Date.now() < deadline) await sleep(20);
  await page.crash();
  const seen = acks.slice();
  const log = seen[0]?.log ?? "";
  const reader = await Page.open(browser, `${origin}/proof/log-queue.html`);
  const freeMs = await reader.call<number>("lockFreeAfter", db, log, 10_000);
  const read = await reader.call<Read>("read", db, log);
  c.that(freeMs >= 0 && read.dead, "the crashed page's log lock is free", freeMs);
  const stop = checkAcked(c, seen, read);
  return c.report([`log=${log} acked_seen=${seen.length} on_disk=${read.records.length} segments=${read.segments} lock_free_after_ms=${freeMs} ${stop}`]);
}

async function killMidAppend(profile: string, origin: string): Promise<{ ok: boolean; browser: Browser }> {
  const c = new Check("kill -9 of the browser mid-append");
  const db = "lq-kill";
  const acks: Ack[] = [];
  const first = await Browser.launch(profile);
  const page = await Page.open(first, `${origin}/proof/log-queue.html`, (p) => acks.push(JSON.parse(p) as Ack));
  await page.call("start", db, 8192);
  await page.call("flood", "k", 900);
  const deadline = Date.now() + 10_000;
  while (acks.length < 2000 && Date.now() < deadline) await sleep(20);
  await first.kill();
  const seen = acks.slice();
  const log = seen[0]?.log ?? "";
  const browser = await Browser.launch(profile);
  const reader = await Page.open(browser, `${origin}/proof/log-queue.html`);
  const read = await reader.call<Read>("read", db, log);
  c.that(read.dead, "the killed browser's log reads as dead after relaunch");
  const stop = checkAcked(c, seen, read);
  return { ok: c.report([`log=${log} acked_seen=${seen.length} on_disk=${read.records.length} segments=${read.segments} ${stop}`]), browser };
}

async function main(): Promise<number> {
  for (const f of ["dist/log/client.js", "dist/log/log-worker.js"]) {
    if (!fs.existsSync(path.join(root, f))) {
      console.error(`missing ${f}. Run pnpm --filter @opfs-lsm/kv build`);
      return 1;
    }
  }
  const { server, origin } = await startServer();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "opfs-log-queue-"));
  const killProfile = fs.mkdtempSync(path.join(os.tmpdir(), "opfs-log-queue-kill-"));
  const browsers: Browser[] = [];
  const results: boolean[] = [];
  try {
    const browser = await Browser.launch(profile);
    browsers.push(browser);
    console.log(`chrome=${browser.version}`);
    const only = process.env.LOG_QUEUE_ONLY;
    for (const run of [clean, suspendResume, stuck, crashMidAppend].filter((r) => !only || r.name === only)) {
      try {
        results.push(await run(browser, origin));
      } catch (err) {
        console.log(`\n## ${run.name}\nFAIL ${err instanceof Error ? err.message : String(err)}`);
        results.push(false);
      }
    }
    if (!only) try {
      const killed = await killMidAppend(killProfile, origin);
      browsers.push(killed.browser);
      results.push(killed.ok);
    } catch (err) {
      console.log(`\n## kill -9\nFAIL ${err instanceof Error ? err.message : String(err)}`);
      results.push(false);
    }
  } finally {
    for (const b of browsers) b.killGroup();
    server.closeAllConnections();
    server.close();
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(killProfile, { recursive: true, force: true });
  }
  const ok = results.every(Boolean);
  console.log(`\n${ok ? "log-queue ok" : "log-queue FAILED"} (${results.filter(Boolean).length}/${results.length} cases)`);
  return ok ? 0 : 1;
}

process.exit(await main());

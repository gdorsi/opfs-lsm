/**
 * Drive the two-tab Chrome proof.
 *
 *   pnpm --filter @opfs-lsm/kv two-tab
 *   TWO_TAB_NOBC=1 pnpm --filter @opfs-lsm/kv exec tsx scripts/two-tab.ts
 *   TWO_TAB_LOCAL=1 pnpm --filter @opfs-lsm/kv exec tsx scripts/two-tab.ts
 *   TWO_TAB_REPEAT=3 pnpm --filter @opfs-lsm/kv exec tsx scripts/two-tab.ts
 *   TWO_TAB_QUOTA=1 pnpm --filter @opfs-lsm/kv exec tsx scripts/two-tab.ts
 *   TWO_TAB_DESTROY=1 pnpm --filter @opfs-lsm/kv exec tsx scripts/two-tab.ts
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import ts from "typescript";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json",
};

type ClientCmd =
  | { op: "put"; key: string; value: string; name?: string }
  | { op: "get"; key: string; name?: string }
  | { op: "ingest"; name?: string }
  | { op: "rows"; name: string }
  | { op: "destroy"; name: string }
  | { op: "full"; key: string; value: string };

type PeerCmd = ClientCmd & { id: number };

type PeerResult = {
  id: number;
  ok: boolean;
  value: string | null;
  generation: number | null;
  error: string | null;
};

type RunOptions = {
  local: boolean;
  nobc: boolean;
  /** Run the reserve scenario, which asks this script to set a real limit on the origin's storage. */
  quota: boolean;
  /** Run the destroyDb scenario, which asks this script to open, crash, freeze and navigate tabs. */
  destroy: boolean;
};

function chromePath(): string {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (fs.existsSync(mac)) return mac;
  return "google-chrome";
}

function contentType(filePath: string): string {
  return MIME[path.extname(filePath)] ?? "application/octet-stream";
}

function safeJoin(base: string, reqPath: string): string | null {
  const decoded = decodeURIComponent((reqPath ?? "/").split("?")[0] ?? "/");
  const cleaned = path.normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const full = path.join(base, cleaned);
  if (!full.startsWith(base)) return null;
  return full;
}

function transpileTs(source: string, fileName: string): string {
  const result = ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      skipLibCheck: true,
    },
  });
  return result.outputText;
}

function parseClientCmd(value: unknown): ClientCmd | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as { op?: unknown; key?: unknown; value?: unknown; name?: unknown };
  const name = typeof rec.name === "string" ? { name: rec.name } : {};
  if (rec.op === "ingest") return { op: "ingest", ...name };
  if ((rec.op === "rows" || rec.op === "destroy") && typeof rec.name === "string") {
    return { op: rec.op, name: rec.name };
  }
  if (rec.op === "full" && typeof rec.key === "string" && typeof rec.value === "string") {
    return { op: "full", key: rec.key, value: rec.value };
  }
  if (rec.op === "get" && typeof rec.key === "string") {
    return { op: "get", key: rec.key, ...name };
  }
  if (
    rec.op === "put" &&
    typeof rec.key === "string" &&
    typeof rec.value === "string"
  ) {
    return { op: "put", key: rec.key, value: rec.value, ...name };
  }
  return null;
}

function parsePeerResult(value: unknown): PeerResult | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.id !== "number" || typeof rec.ok !== "boolean") return null;
  if (!(rec.value === null || typeof rec.value === "string")) return null;
  if (!(rec.generation === null || typeof rec.generation === "number")) {
    return null;
  }
  if (!(rec.error === null || typeof rec.error === "string")) return null;
  return {
    id: rec.id,
    ok: rec.ok,
    value: rec.value,
    generation: rec.generation,
    error: rec.error,
  };
}

class PeerHub {
  private nextId = 1;
  private queue: PeerCmd[] = [];
  private nextWaiters: {
    resolve: (cmd: PeerCmd) => void;
    reject: (err: Error) => void;
  }[] = [];
  private results = new Map<number, (result: PeerResult) => void>();
  private ready = false;
  private readyWaiters: {
    resolve: () => void;
    reject: (err: Error) => void;
  }[] = [];

  markReady(): void {
    this.ready = true;
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const waiter of waiters) waiter.resolve();
  }

  waitReady(timeoutMs: number): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const entry = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      const timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((w) => w !== entry);
        reject(new Error("tab B did not connect"));
      }, timeoutMs);
      this.readyWaiters.push(entry);
    });
  }

  call(cmd: ClientCmd, timeoutMs: number): Promise<PeerResult> {
    const id = this.nextId++;
    const full = { ...cmd, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.results.delete(id);
        reject(new Error(`peer timed out on ${cmd.op}`));
      }, timeoutMs);
      this.results.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      this.deliver(full);
    });
  }

  takeNext(timeoutMs: number): Promise<PeerCmd> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const entry = {
        resolve: (cmd: PeerCmd) => {
          clearTimeout(timer);
          resolve(cmd);
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      const timer = setTimeout(() => {
        this.nextWaiters = this.nextWaiters.filter((w) => w !== entry);
        reject(new Error("peer next timed out"));
      }, timeoutMs);
      this.nextWaiters.push(entry);
    });
  }

  complete(result: PeerResult): boolean {
    const waiter = this.results.get(result.id);
    if (!waiter) return false;
    this.results.delete(result.id);
    waiter(result);
    return true;
  }

  close(): void {
    const err = new Error("peer hub closed");
    for (const waiter of this.nextWaiters) waiter.reject(err);
    for (const waiter of this.readyWaiters) waiter.reject(err);
    this.nextWaiters = [];
    this.readyWaiters = [];
    this.results.clear();
    this.queue = [];
  }

  private deliver(cmd: PeerCmd): void {
    const waiter = this.nextWaiters.shift();
    if (waiter) waiter.resolve(cmd);
    else this.queue.push(cmd);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      if (!addr || typeof addr === "string") {
        probe.close();
        reject(new Error("expected a TCP port"));
        return;
      }
      const { port } = addr;
      probe.close(() => resolve(port));
    });
  });
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function emptyResult(error: string): PeerResult {
  return { id: 0, ok: false, value: null, generation: null, error };
}

async function waitForDebugger(port: number): Promise<string> {
  const deadline = Date.now() + 10_000;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        const body = (await res.json()) as { webSocketDebuggerUrl?: string };
        if (body.webSocketDebuggerUrl) return body.webSocketDebuggerUrl;
        last = "missing webSocketDebuggerUrl";
      } else {
        last = `status ${res.status}`;
      }
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await sleep(50);
  }
  throw new Error(`devtools not ready: ${last}`);
}

function openTarget(wsUrl: string, url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("devtools target timeout"));
    }, 10_000);
    ws.addEventListener("open", () => ws.send(JSON.stringify({ id: 1, method: "Target.createTarget", params: { url } })));
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; error?: { message?: string }; result?: { targetId?: string } };
      if (msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (msg.error) reject(new Error(msg.error.message ?? "devtools target failed"));
      else if (!msg.result?.targetId) reject(new Error("devtools did not return a target id"));
      else resolve(msg.result.targetId);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("devtools socket error"));
    });
  });
}

/** A DevTools session on one page that stays open, so a frozen page stays frozen, and that keeps why the page was not restored from the back/forward cache. */
class PageSession {
  private id = 0;
  private readonly waiting = new Map<number, (msg: { result?: unknown; error?: { message?: string } }) => void>();
  readonly notRestored: string[] = [];

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number;
        method?: string;
        params?: { notRestoredExplanations?: { reason: string }[] };
        result?: unknown;
        error?: { message?: string };
      };
      if (msg.method === "Page.backForwardCacheNotUsed") {
        for (const e of msg.params?.notRestoredExplanations ?? []) this.notRestored.push(e.reason);
      }
      if (msg.id !== undefined) this.waiting.get(msg.id)?.(msg);
    });
    ws.addEventListener("close", () => {
      for (const settle of this.waiting.values()) settle({ error: { message: "devtools socket closed" } });
      this.waiting.clear();
    });
  }

  static async open(debugPort: number, targetId: string): Promise<PageSession> {
    const list = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()) as { id: string; webSocketDebuggerUrl: string }[];
    const target = list.find((t) => t.id === targetId);
    if (!target) throw new Error(`no target ${targetId}`);
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("devtools socket error")));
    });
    const session = new PageSession(ws);
    await session.send("Page.enable");
    return session;
  }

  send<T = Record<string, unknown>>(method: string, params: object = {}): Promise<T> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`devtools ${method} timeout`));
      }, 60_000);
      this.waiting.set(id, (msg) => {
        clearTimeout(timer);
        this.waiting.delete(id);
        if (msg.error) reject(new Error(msg.error.message ?? `devtools ${method} failed`));
        else resolve(msg.result as T);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.ws.close();
  }
}

async function countProofTabs(debugPort: number): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
  if (!res.ok) throw new Error(`json/list ${res.status}`);
  const list = (await res.json()) as { type?: string; url?: string }[];
  return list.filter(
    (target) =>
      target.type === "page" &&
      (target.url ?? "").includes("/proof/two-tab.html"),
  ).length;
}

function chromeArgs(profile: string, debugPort: number, url: string): string[] {
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--enable-features=FileSystemAccessAPI",
    "--remote-allow-origins=*",
    // Tab B runs ingest. Headless Chrome throttles background pages.
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
  ];
  if (process.env.CI === "true") {
    args.push("--no-sandbox", "--disable-dev-shm-usage");
  }
  args.push(
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${debugPort}`,
    url,
  );
  return args;
}

function killChrome(child: ChildProcess): void {
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

async function runOnce(options: RunOptions): Promise<number> {
  const dist = path.join(root, "dist/index.js");
  const worker = path.join(root, "dist/host/shared-worker.js");
  if (!fs.existsSync(dist) || !fs.existsSync(worker)) {
    console.error("missing dist. Run pnpm --filter @opfs-lsm/kv build");
    return 1;
  }

  const hub = new PeerHub();
  let resolveResults!: (body: string) => void;
  let settled = false;
  const resultsPromise = new Promise<string>((resolve) => {
    resolveResults = (body) => {
      if (settled) return;
      settled = true;
      resolve(body);
    };
  });

  /** The destroy scenario's holder tabs, by tag. */
  const holders = new Map<string, { targetId: string; session?: PageSession }>();
  const latches = new Map<string, { promise: Promise<void>; open: () => void }>();
  const latch = (what: string) => {
    let entry = latches.get(what);
    if (!entry) {
      let open!: () => void;
      const promise = new Promise<void>((resolve) => (open = resolve));
      entry = { promise, open };
      latches.set(what, entry);
    }
    return entry;
  };
  const sessionOf = async (tag: string) => {
    const entry = holders.get(tag);
    if (!entry) throw new Error(`no tab ${tag}`);
    entry.session ??= await PageSession.open(debugPort, entry.targetId);
    return entry.session;
  };
  /** One DevTools step of the destroy scenario on the tab `tag`. */
  const devtools = async (q: URLSearchParams): Promise<unknown> => {
    const op = q.get("op");
    const tag = q.get("tag") ?? "";
    if (op === "open") {
      const url = `http://127.0.0.1:${port}/proof/two-tab.html?${new URLSearchParams({ role: "holder", tag, db: q.get("db") ?? "" })}`;
      holders.set(tag, { targetId: await openTarget(wsUrl!, url) });
      await Promise.race([latch(tag).promise, sleep(30_000).then(() => Promise.reject(new Error(`tab ${tag} did not get ready`)))]);
      return "ready";
    }
    const page = await sessionOf(tag);
    switch (op) {
      case "eval": {
        const r = await page.send<{ result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string } } }>("Runtime.evaluate", {
          expression: q.get("expr"),
          awaitPromise: true,
          returnByValue: true,
        });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "evaluate failed");
        return r.result?.value ?? null;
      }
      case "crash":
        // The renderer dies before it answers.
        void page.send("Page.crash").catch(() => undefined);
        await sleep(500);
        return "crashed";
      case "freeze":
      case "resume":
        await page.send("Page.setWebLifecycleState", { state: op === "freeze" ? "frozen" : "active" });
        return op;
      case "away":
        await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/proof/two-tab.html?role=idle` });
        await sleep(1_500);
        return "away";
      case "back": {
        const { currentIndex, entries } = await page.send<{ currentIndex: number; entries: { id: number }[] }>("Page.getNavigationHistory");
        await page.send("Page.navigateToHistoryEntry", { entryId: entries[currentIndex - 1]!.id });
        await sleep(1_500);
        return "back";
      }
      case "notRestored":
        return page.notRestored;
      default:
        throw new Error(`unknown devtools op ${op}`);
    }
  };
  let wsUrl: string | undefined;
  let quotaSession: PageSession | undefined;

  const server = http.createServer(async (req, res) => {
    const urlPath = (req.url ?? "/").split("?")[0] ?? "/";
    try {
      if (req.method === "POST" && urlPath === "/signal") {
        latch(new URL(req.url!, "http://x").searchParams.get("what") ?? "").open();
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === "POST" && urlPath === "/cdp") {
        try {
          json(res, 200, { value: await devtools(new URL(req.url!, "http://x").searchParams) });
        } catch (err) {
          json(res, 200, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      if (req.method === "POST" && urlPath === "/two-tab-results") {
        resolveResults(await readBody(req));
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === "POST" && urlPath === "/quota") {
        const size = new URL(req.url!, "http://x").searchParams.get("size");
        // The override ends with the DevTools session that set it, so one session stays open.
        if (!quotaSession) {
          const targets = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()) as { id: string; type: string; url: string }[];
          const tab = targets.find((t) => t.type === "page" && t.url.includes("role=a"));
          if (!tab) throw new Error("no tab A to set the quota from");
          quotaSession = await PageSession.open(debugPort, tab.id);
        }
        const origin = `http://127.0.0.1:${port}`;
        await quotaSession.send("Storage.overrideQuotaForOrigin", size === null ? { origin } : { origin, quotaSize: Number(size) });
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === "POST" && urlPath === "/peer/ready") {
        hub.markReady();
        res.writeHead(200);
        res.end("ok");
        return;
      }
      if (req.method === "GET" && urlPath === "/peer/ready") {
        await hub.waitReady(15_000);
        res.writeHead(200);
        res.end("ok");
        return;
      }
      if (req.method === "POST" && urlPath === "/peer/call") {
        const cmd = parseClientCmd(JSON.parse(await readBody(req)));
        if (!cmd) {
          json(res, 400, emptyResult("bad peer command"));
          return;
        }
        const result = await hub.call(cmd, 15_000);
        json(res, 200, result);
        return;
      }
      if (req.method === "GET" && urlPath === "/peer/next") {
        const cmd = await hub.takeNext(20_000);
        json(res, 200, cmd);
        return;
      }
      if (req.method === "POST" && urlPath === "/peer/result") {
        const result = parsePeerResult(JSON.parse(await readBody(req)));
        if (!result || !hub.complete(result)) {
          json(res, 404, emptyResult("no waiter"));
          return;
        }
        json(res, 200, { ok: true });
        return;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) json(res, 504, emptyResult(message));
      return;
    }

    const fileUrl = urlPath === "/" ? "/proof/two-tab.html" : urlPath;
    const filePath = safeJoin(root, fileUrl);
    if (!filePath) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end(`missing ${fileUrl}`);
        return;
      }
      let body: string | Buffer = data;
      if (path.extname(filePath) === ".ts") {
        body = transpileTs(data.toString("utf8"), filePath);
      }
      res.writeHead(200, {
        "content-type": contentType(filePath),
        // The profile is new on each run, so nothing stale is cached. "no-store" keeps a page out of the back/forward cache.
        "cache-control": options.destroy ? "no-cache" : "no-store",
      });
      res.end(body);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP listen address");
  }
  const { port } = address;
  const debugPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "opfs-two-tab-"));

  const query = new URLSearchParams({ auto: "1", name: "two-tab" });
  if (options.nobc) query.set("nobc", "1");
  if (options.quota) query.set("scenario", "quota");
  if (options.destroy) query.set("scenario", "destroy");
  if (options.local) query.set("local", "1");
  else query.set("role", "a");
  const tabA = `http://127.0.0.1:${port}/proof/two-tab.html?${query}`;
  const tabBQuery = new URLSearchParams({
    auto: "1",
    name: "two-tab",
    role: "b",
  });
  if (options.nobc) tabBQuery.set("nobc", "1");
  if (options.quota) tabBQuery.set("scenario", "quota");
  const tabB = `http://127.0.0.1:${port}/proof/two-tab.html?${tabBQuery}`;

  console.log(`Opening ${tabA}`);
  const started = Date.now();
  const chrome = spawn(chromePath(), chromeArgs(profile, debugPort, tabA), {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let stderr = "";
  chrome.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    if (process.env.TWO_TAB_VERBOSE) process.stderr.write(chunk);
  });
  chrome.stdout?.on("data", (chunk: Buffer) => {
    if (process.env.TWO_TAB_VERBOSE) process.stdout.write(chunk);
  });
  const timeoutMs = options.destroy ? 150_000 : 45_000;
  let exitCode = 0;
  try {
    wsUrl = await waitForDebugger(debugPort);
    if (!options.local && !options.destroy) await openTarget(wsUrl, tabB);
    const raw = await Promise.race([
      resultsPromise,
      sleep(timeoutMs).then(() => {
        throw new Error(
          `two-tab timed out after ${timeoutMs}ms\nChrome stderr (tail):\n${stderr.slice(-4000)}`,
        );
      }),
    ]);
    const tabs = await countProofTabs(debugPort);
    const expected = options.local ? 1 : 2;
    if (tabs < expected) {
      throw new Error(`expected ${expected} two-tab pages, saw ${tabs}`);
    }
    console.log(`tabs=${tabs}`);
    const parsed = JSON.parse(raw) as { error?: string; log?: string };
    const wall = Date.now() - started;
    if (parsed.log) console.log(parsed.log.trimEnd());
    console.log(`wall_ms=${wall}`);
    if (parsed.error) {
      console.error(parsed.error);
      exitCode = 1;
    } else if (!parsed.log?.includes(options.destroy ? "destroy ok" : options.quota ? "quota ok" : "two-tab ok")) {
      console.error("missing the ok line");
      exitCode = 1;
    } else if (!options.quota && !options.destroy && !parsed.log.includes("two-databases ok")) {
      console.error("missing the two-databases ok line");
      exitCode = 1;
    } else if (!options.local && !parsed.log.includes("mode=SharedWorker")) {
      console.error("missing SharedWorker mode");
      exitCode = 1;
    } else if (options.local && !parsed.log.includes("mode=local EngineHost")) {
      console.error("missing local EngineHost mode");
      exitCode = 1;
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    exitCode = 1;
  } finally {
    for (const { session } of holders.values()) session?.close();
    quotaSession?.close();
    killChrome(chrome);
    chrome.stdout?.destroy();
    chrome.stderr?.destroy();
    chrome.unref();
    hub.close();
    server.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  }
  return exitCode;
}

function flag(name: string): boolean {
  return process.env[name] === "1";
}

async function main(): Promise<number> {
  const repeat = Number(process.env.TWO_TAB_REPEAT ?? 1);
  if (!Number.isInteger(repeat) || repeat < 1) {
    console.error("TWO_TAB_REPEAT must be a positive integer");
    return 1;
  }
  const options = {
    local: flag("TWO_TAB_LOCAL"),
    nobc: flag("TWO_TAB_NOBC"),
    quota: flag("TWO_TAB_QUOTA"),
    destroy: flag("TWO_TAB_DESTROY"),
  };
  for (let i = 0; i < repeat; i += 1) {
    if (repeat > 1) console.log(`run ${i + 1}/${repeat}`);
    const code = await runOnce(options);
    if (code !== 0) return code;
  }
  return 0;
}

const code = await main();
process.exit(code);

/**
 * Serve the package over HTTP and drive the OPFS browser bench in Chrome.
 *
 *   pnpm --filter @opfs-lsm/kv build && pnpm bench:browser
 *   BENCH_N=100 pnpm bench:browser
 *   BENCH_LOCAL=1 pnpm bench:browser
 *   BENCH_PAGE=latency BENCH_N=100000 pnpm bench:browser
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import ts from "typescript";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const N = Number(process.env.BENCH_N ?? 200);
const PAGE = process.env.BENCH_PAGE ?? "browser";
const QUERY = process.env.BENCH_QUERY ? `&${process.env.BENCH_QUERY}` : "";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  // Vendor packages (e.g. dexie) still ship .mjs — serve as JS modules.
  ".mjs": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".map": "application/json",
};

function chromePath(): string {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const mac =
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
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

/** How one Chrome launch ended. */
export type Outcome =
  | { kind: "result"; body: string }
  | { kind: "chrome-exit"; code: number | null; signal: NodeJS.Signals | null }
  | { kind: "network-crash" }
  | { kind: "timeout" };

/** The launch a bench POST belongs to. */
export type BenchAttempt = {
  startedAt: number;
  trail: string[];
  settle: (outcome: Outcome) => void;
};

type LaunchReport = { outcome: Outcome; trail: string[]; stderr: string };

/** Chrome's log line when its network service process dies. */
const NETWORK_CRASH = "Network service crashed or was terminated";
const MAX_ATTEMPTS = 2;
const TRAIL_LINES = 20;
/** SIGKILL is immediate. This only bounds a process stuck where the kernel will not reap it. */
const KILL_WAIT_MS = 5_000;

export function sawNetworkCrash(stderr: string): boolean {
  return stderr.includes(NETWORK_CRASH);
}

/** One relaunch, and only when this launch's network service died. */
function relaunchAfter(kind: Outcome["kind"], attemptNumber: number): boolean {
  return kind === "network-crash" && attemptNumber < MAX_ATTEMPTS;
}

function parseResult(body: string): { error?: string; log?: string } | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as { error?: string; log?: string };
  } catch {
    return null;
  }
}

function remember(target: BenchAttempt, line: string): void {
  target.trail.push(`+${Date.now() - target.startedAt}ms ${line}`);
  if (target.trail.length > TRAIL_LINES) target.trail.shift();
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function reply(res: http.ServerResponse, status: number, body?: string): void {
  try {
    if (body === undefined) res.writeHead(status);
    else res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  } catch {
    // The launch already closed this socket.
  }
}

/**
 * Bench POSTs. The body arrives after an await, so the launch that accepted
 * the request is captured first: a relaunch must not adopt this body.
 * Returns false when the request is an ordinary file fetch.
 */
export async function handleBenchPost(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  current: () => BenchAttempt | null,
): Promise<boolean> {
  if (req.method === "POST" && req.url === "/bench-results") {
    const captured = current();
    try {
      const body = await readBody(req);
      // A reset connection ends the body early. That fragment is not a result,
      // so the crash line can still relaunch.
      const parsed = parseResult(body);
      reply(res, parsed ? 200 : 400, parsed ? '{"ok":true}' : undefined);
      if (parsed) captured?.settle({ kind: "result", body });
    } catch {
      reply(res, 400);
    }
    return true;
  }
  if (req.method === "POST" && req.url === "/bench-progress") {
    const captured = current();
    try {
      const text = await readBody(req);
      if (captured) remember(captured, `page: ${text}`);
    } catch {
      // The launch ended while this line was still arriving.
    }
    reply(res, 204);
    return true;
  }
  return false;
}

function describe(outcome: Exclude<Outcome, { kind: "result" }>, timeoutMs: number): string {
  switch (outcome.kind) {
    case "timeout":
      return `bench timed out after ${timeoutMs}ms`;
    case "chrome-exit":
      return `Chrome exited (code ${outcome.code}, signal ${outcome.signal}) before the page reported`;
    case "network-crash":
      return "Chrome's network service crashed before the page reported";
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

/** Drive launches until the page reports, or relaunch once after a network-service crash. */
export async function runAttempts(
  launch: () => Promise<LaunchReport>,
  timeoutMs: number,
): Promise<number> {
  let exitCode = 1;
  for (let n = 1; n <= MAX_ATTEMPTS; n++) {
    const { outcome, trail, stderr } = await launch();
    if (outcome.kind === "result") {
      const parsed = parseResult(outcome.body);
      if (!parsed) {
        console.error("bench result was not JSON");
        break;
      }
      if (parsed.error) {
        console.error(parsed.error);
      } else {
        console.log(parsed.log ?? JSON.stringify(parsed, null, 2));
        exitCode = 0;
      }
      break;
    }
    console.error(describe(outcome, timeoutMs));
    console.error(`Last requests and page lines (attempt ${n}):`);
    console.error(trail.length > 0 ? trail.join("\n") : "(none: the page never loaded)");
    console.error(`Chrome stderr (tail):\n${stderr.slice(-4000)}`);
    if (!relaunchAfter(outcome.kind, n)) break;
    console.error("Relaunching Chrome once on a fresh profile.");
  }
  return exitCode;
}

function killChrome(chrome: ChildProcess): Promise<void> {
  if (chrome.exitCode !== null || chrome.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      console.error(`Chrome did not exit within ${KILL_WAIT_MS}ms of SIGKILL`);
      done();
    }, KILL_WAIT_MS);
    chrome.once("exit", done);
    try {
      chrome.kill("SIGKILL");
    } catch {
      done();
    }
  });
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

async function main(): Promise<void> {
  /** The launch in flight. Cleared when that launch settles. */
  let attempt: BenchAttempt | null = null;

  const server = http.createServer((req, res) => {
    void (async () => {
      if (await handleBenchPost(req, res, () => attempt)) return;
      if (attempt) remember(attempt, `${req.method} ${req.url}`);

      const urlPath = req.url === "/" ? "/bench/browser.html" : (req.url ?? "/");
      const filePath = safeJoin(root, urlPath);
      if (!filePath) {
        res.writeHead(403);
        res.end("forbidden");
        return;
      }

      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end(`missing ${urlPath}`);
          return;
        }
        let body: string | Buffer = data;
        if (path.extname(filePath) === ".ts") {
          body = transpileTs(data.toString("utf8"), filePath);
        }
        res.writeHead(200, {
          "content-type": contentType(filePath),
          "cache-control": "no-store",
          // Cross-origin isolation lifts performance.now() from 100 µs to 5 µs steps.
          "cross-origin-opener-policy": "same-origin",
          "cross-origin-embedder-policy": "require-corp",
        });
        res.end(body);
      });
    })().catch((err) => {
      console.error(err instanceof Error ? err.message : err);
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
  // SharedWorker is the default. BENCH_LOCAL=1 opens the page with local=1.
  const local = process.env.BENCH_LOCAL === "1" ? "&local=1" : "";
  const target = `http://127.0.0.1:${port}/bench/${PAGE}.html?auto=1&n=${N}${local}${QUERY}`;
  const profile = path.join(root, ".bench-chrome-profile");
  const timeoutMs = Number(process.env.BENCH_TIMEOUT_MS ?? 120_000);

  console.log(`Serving ${root}`);
  console.log(`Opening ${target}`);

  /** Launch Chrome on a fresh profile and wait for the first way the launch ends. */
  async function launch(): Promise<LaunchReport> {
    fs.rmSync(profile, { recursive: true, force: true });
    fs.mkdirSync(profile, { recursive: true });

    const chrome: ChildProcess = spawn(
      chromePath(),
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--enable-features=FileSystemAccessAPI",
        `--user-data-dir=${profile}`,
        // Real wall clock — do not use virtual-time-budget (starves IDB/OPFS).
        target,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    const trail: string[] = [];
    let stderr = "";
    const outcome = await new Promise<Outcome>((resolve) => {
      let settled = false;
      const settle = (o: Outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        attempt = null;
        resolve(o);
      };
      const timer = setTimeout(() => settle({ kind: "timeout" }), timeoutMs);
      attempt = { startedAt: Date.now(), trail, settle };
      chrome.stderr?.on("data", (d: Buffer) => {
        stderr += d.toString();
        if (process.env.BENCH_VERBOSE) process.stderr.write(d);
        // The restarted service does not resend the page's lost requests, so
        // this launch can no longer report.
        if (sawNetworkCrash(stderr)) settle({ kind: "network-crash" });
      });
      chrome.stdout?.on("data", (d: Buffer) => {
        if (process.env.BENCH_VERBOSE) process.stdout.write(d);
      });
      chrome.on("exit", (code, signal) => settle({ kind: "chrome-exit", code, signal }));
    });
    // Reap this Chrome and drop its sockets before another launch can accept a POST.
    await killChrome(chrome);
    server.closeAllConnections();
    return { outcome, trail, stderr };
  }

  let exitCode = 1;
  try {
    exitCode = await runAttempts(() => launch(), timeoutMs);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    exitCode = 1;
  } finally {
    server.close();
    // Headless Chrome can keep the event loop alive via open handles.
    process.exit(exitCode);
  }
}

if (isDirectRun()) {
  await main();
}

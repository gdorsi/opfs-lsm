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
import { fileURLToPath } from "node:url";
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
type Outcome =
  | { kind: "result"; body: string }
  | { kind: "chrome-exit"; code: number | null; signal: NodeJS.Signals | null }
  | { kind: "network-crash" }
  | { kind: "timeout" };

/** Chrome's log line when its network service process dies. */
const NETWORK_CRASH = "Network service crashed or was terminated";
const MAX_ATTEMPTS = 2;
const TRAIL_LINES = 20;

/** The launch in flight: what the page sent and how to end the launch. */
let attempt: {
  startedAt: number;
  trail: string[];
  settle: (outcome: Outcome) => void;
} | null = null;

function note(line: string): void {
  if (!attempt) return;
  attempt.trail.push(`+${Date.now() - attempt.startedAt}ms ${line}`);
  if (attempt.trail.length > TRAIL_LINES) attempt.trail.shift();
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/bench-results") {
    const body = await readBody(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
    attempt?.settle({ kind: "result", body });
    return;
  }
  if (req.method === "POST" && req.url === "/bench-progress") {
    note(`page: ${await readBody(req)}`);
    res.writeHead(204);
    res.end();
    return;
  }
  note(`${req.method} ${req.url}`);

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
async function launch(): Promise<{ outcome: Outcome; trail: string[]; stderr: string }> {
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
      if (stderr.includes(NETWORK_CRASH)) settle({ kind: "network-crash" });
    });
    chrome.stdout?.on("data", (d: Buffer) => {
      if (process.env.BENCH_VERBOSE) process.stdout.write(d);
    });
    chrome.on("exit", (code, signal) => settle({ kind: "chrome-exit", code, signal }));
  });
  chrome.kill("SIGKILL");
  return { outcome, trail, stderr };
}

function describe(outcome: Exclude<Outcome, { kind: "result" }>): string {
  switch (outcome.kind) {
    case "timeout":
      return `bench timed out after ${timeoutMs}ms`;
    case "chrome-exit":
      return `Chrome exited (code ${outcome.code}, signal ${outcome.signal}) before the page reported`;
    case "network-crash":
      return "Chrome's network service crashed before the page reported";
  }
}

let exitCode = 1;
for (let n = 1; n <= MAX_ATTEMPTS; n++) {
  const { outcome, trail, stderr } = await launch();
  if (outcome.kind === "result") {
    const parsed = JSON.parse(outcome.body) as { error?: string; log?: string };
    if (parsed.error) {
      console.error(parsed.error);
    } else {
      console.log(parsed.log ?? JSON.stringify(parsed, null, 2));
      exitCode = 0;
    }
    break;
  }
  console.error(describe(outcome));
  console.error(`Last requests and page lines (attempt ${n}):`);
  console.error(trail.length > 0 ? trail.join("\n") : "(none: the page never loaded)");
  console.error(`Chrome stderr (tail):\n${stderr.slice(-4000)}`);
  if (outcome.kind !== "network-crash") break;
  if (n < MAX_ATTEMPTS) console.error("Relaunching Chrome once on a fresh profile.");
}
server.close();
// Headless Chrome can keep the event loop alive via open handles.
process.exit(exitCode);

/**
 * Serve the package over HTTP and drive the OPFS browser bench in Chrome.
 *
 *   pnpm --filter @opfs-lsm/kv build && pnpm bench:browser
 *   BENCH_N=100 pnpm bench:browser
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import ts from "typescript";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const N = Number(process.env.BENCH_N ?? 200);

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

let resolveResults!: (body: string) => void;
const resultsPromise = new Promise<string>((resolve) => {
  resolveResults = resolve;
});

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/bench-results") {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
    resolveResults(body);
    return;
  }

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
// Prefer in-page EngineHost+OPFS for headless stability; SharedWorker via BENCH_SW=1.
const sw = process.env.BENCH_SW === "1" ? "" : "&local=1";
const target = `http://127.0.0.1:${port}/bench/browser.html?auto=1&n=${N}${sw}`;
const profile = path.join(root, ".bench-chrome-profile");
fs.rmSync(profile, { recursive: true, force: true });
fs.mkdirSync(profile, { recursive: true });

console.log(`Serving ${root}`);
console.log(`Opening ${target}`);

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

let stderr = "";
chrome.stderr?.on("data", (d: Buffer) => {
  stderr += d.toString();
  if (process.env.BENCH_VERBOSE) process.stderr.write(d);
});
chrome.stdout?.on("data", (d: Buffer) => {
  if (process.env.BENCH_VERBOSE) process.stdout.write(d);
});

const timeoutMs = 120_000;
const timed = Promise.race([
  resultsPromise,
  sleep(timeoutMs).then(() => {
    throw new Error(
      `bench timed out after ${timeoutMs}ms\nChrome stderr (tail):\n${stderr.slice(-4000)}`,
    );
  }),
]);

let exitCode = 0;
try {
  const raw = await timed;
  const parsed = JSON.parse(raw) as {
    error?: string;
    log?: string;
  };
  if (parsed.error) {
    console.error(parsed.error);
    exitCode = 1;
  } else {
    console.log(parsed.log ?? JSON.stringify(parsed, null, 2));
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  exitCode = 1;
} finally {
  try {
    chrome.kill("SIGKILL");
  } catch {
    /* ignore */
  }
  server.close();
  // Headless Chrome can keep the event loop alive via open handles.
  process.exit(exitCode);
}

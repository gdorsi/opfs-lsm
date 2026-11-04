import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const dist = path.join(root, "packages/kv/dist/index.js");

if (!fs.existsSync(dist)) {
  console.error(
    "Missing packages/kv/dist/index.js. Run pnpm --filter @opfs-lsm/kv build",
  );
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
};

function contentType(filePath) {
  return MIME[path.extname(filePath)] ?? "application/octet-stream";
}

function safeJoin(base, reqPath) {
  const decoded = decodeURIComponent((reqPath ?? "/").split("?")[0] ?? "/");
  const cleaned = path.normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const full = path.join(base, cleaned);
  const rootWithSep = base.endsWith(path.sep) ? base : base + path.sep;
  if (full !== base && !full.startsWith(rootWithSep)) return null;
  if (full.split(path.sep).includes(".git")) return null;
  return full;
}

function resolveFile(reqPath) {
  const filePath = safeJoin(root, reqPath);
  if (!filePath) return null;
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    return path.join(filePath, "index.html");
  }
  return filePath;
}

const port = Number(process.env.TODO_PORT ?? 4173);
if (!Number.isInteger(port) || port <= 0) {
  console.error("TODO_PORT must be a positive integer");
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const urlPath = req.url === "/" ? "/examples/todo/index.html" : (req.url ?? "/");
  const filePath = resolveFile(urlPath);
  if (!filePath) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("missing");
      return;
    }
    res.writeHead(200, {
      "content-type": contentType(filePath),
      "cache-control": "no-store",
    });
    res.end(data);
  });
});

server.on("error", (err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

server.listen(port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${port}/examples/todo/index.html`;
  console.log(url);
  if (process.env.TODO_NO_OPEN === "1") return;
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(opener, [url], { stdio: "ignore", detached: true }).unref();
});

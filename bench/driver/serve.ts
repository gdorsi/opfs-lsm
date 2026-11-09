/**
 * Static server over the Vite build (and the downloaded trace data).
 * COOP same-origin + COEP require-corp make the page cross-origin isolated,
 * which lifts performance.now() resolution from 100 µs to 5 µs.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
};

function respond(res: ServerResponse, file: string): void {
  res.writeHead(200, {
    "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
    "cache-control": "no-store",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-embedder-policy": "require-corp",
  });
  createReadStream(file).pipe(res);
}

export type Server = {
  origin: string;
  /**
   * Answer every `.wasm` request with `file` instead of the built asset
   * (undefined restores the build). The tab and kv's SharedWorker host load
   * the engine separately, and only the server sees both. Resets the count.
   */
  useEngine(file: string | undefined): void;
  /** `.wasm` requests answered from the override since `useEngine`. */
  engineServed(): number;
  close(): Promise<void>;
};

export async function serve(roots: { "/": string; "/data/": string }): Promise<Server> {
  let engineFile: string | undefined;
  let engineServed = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (engineFile && url.pathname.endsWith(".wasm")) {
      engineServed++;
      respond(res, engineFile);
      return;
    }
    const isData = url.pathname.startsWith("/data/");
    const root = isData ? roots["/data/"] : roots["/"];
    const rel = decodeURIComponent(isData ? url.pathname.slice("/data/".length) : url.pathname.slice(1)) || "index.html";
    const file = path.resolve(root, rel);
    if (!file.startsWith(path.resolve(root) + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    respond(res, file);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    origin: `http://127.0.0.1:${port}`,
    useEngine(file) {
      engineFile = file;
      engineServed = 0;
    },
    engineServed: () => engineServed,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

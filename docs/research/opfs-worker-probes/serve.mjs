// Static server for the OPFS worker probe page. Saves each run's results.
// node docs/research/opfs-worker-probes/serve.mjs [port]
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL(".", import.meta.url));
const resultsDir = join(dir, "results");
const port = Number(process.argv[2] ?? 8787);
const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json" };

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (process.env.PROBE_LOG) console.log(req.method, url.pathname + url.search, req.headers["user-agent"]?.slice(-40));
  if (req.method === "POST" && url.pathname === "/results") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const name = (url.searchParams.get("browser") ?? "unknown").replace(/[^a-z0-9-]/gi, "");
    await mkdir(resultsDir, { recursive: true });
    const file = join(resultsDir, `${name}-${Date.now()}.json`);
    await writeFile(file, body);
    console.log(`results: ${file}`);
    res.writeHead(204).end();
    return;
  }
  const path = normalize(url.pathname === "/" ? "/index.html" : url.pathname);
  if (path.includes("..")) return res.writeHead(400).end();
  try {
    const data = await readFile(join(dir, path));
    res.writeHead(200, {
      "content-type": types[extname(path)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(data);
  } catch {
    res.writeHead(404).end();
  }
}).listen(port, "127.0.0.1", () => console.log(`probe: http://localhost:${port}/`));

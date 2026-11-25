// Serves the probe cross-origin isolated and runs it in fresh headless Chrome launches.
// node docs/research/sab-sync-read/run.mjs [launches=3] [rounds=8]
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL(".", import.meta.url));
const launches = Number(process.argv[2] ?? 3);
const rounds = Number(process.argv[3] ?? 8);
const chromePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const types = { ".html": "text/html", ".js": "text/javascript" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = createServer(async (req, res) => {
  const path = normalize(new URL(req.url, "http://localhost").pathname);
  try {
    const data = await readFile(join(dir, path === "/" ? "index.html" : path));
    res.writeHead(200, {
      "content-type": types[extname(path)] ?? "text/html",
      "cache-control": "no-store",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
    });
    res.end(data);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://localhost:${server.address().port}`;

async function launch(seed) {
  const profile = await mkdtemp(join(tmpdir(), "sab-probe-"));
  const port = 9400 + seed;
  const chrome = spawn(chromePath, [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "about:blank",
  ]);
  try {
    let target;
    for (let i = 0; i < 60 && !target; i++) {
      await sleep(250);
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => null);
      target = list?.find((t) => t.type === "page");
    }
    if (!target) throw new Error("no page target");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0;
    const pending = new Map();
    ws.onmessage = ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    };
    const send = (method, params = {}) =>
      new Promise((resolve) => {
        pending.set(++id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
      });
    await send("Page.enable");
    await send("Page.navigate", { url: `${base}/` });
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const r = await send("Runtime.evaluate", { expression: "typeof runProbe", returnByValue: true });
      if (r.result?.result?.value === "function") break;
    }
    const r = await send("Runtime.evaluate", {
      expression: `runProbe({ rounds: ${rounds}, seed: ${seed} })`,
      awaitPromise: true,
      returnByValue: true,
    });
    ws.close();
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception ?? r.result.exceptionDetails));
    return r.result.result.value;
  } finally {
    chrome.kill();
    await sleep(500);
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
}

const results = [];
for (let i = 1; i <= launches; i++) {
  const r = await launch(i);
  results.push(r);
  console.log(`\n== launch ${i}: ${r.userAgent.match(/Chrome\/[\d.]+/)?.[0]}, shared read ${r.sharedRead}, worker start ${JSON.stringify(r.workerStartMs)}, max spins ${r.maxSpins}, worker spin window ${r.workerSpinMs} ms, copy of one page out of the shared buffer ${r.copyOutUs} µs`);
  console.log(`feature check: ${JSON.stringify(r.featureCheck)}`);
  console.table(r.perRead.map(({ name, ...rest }) => ({ name, ...rest })));
  console.table(r.batch450);
  console.table(r.sizes.map((s) => ({ bytes: s.bytes, "async mean": s.asyncSlice.mean, "async p50": s.asyncSlice.p50, "sab mean": s.sabSpin.mean, "sab p50": s.sabSpin.p50, "sab max": s.sabSpin.max, errors: s.asyncSlice.errors + s.sabSpin.errors })));
  for (const [mode, o] of Object.entries(r.opens)) console.log(`open ${mode}, µs a file: main getFile p50 ${o.mainGetFile.p50}, worker sync handle p50 ${o.workerSyncHandle.p50}, worker close p50 ${o.workerClose.p50}`);
}
await mkdir(join(dir, "results"), { recursive: true });
const file = join(dir, "results", `chrome-${Date.now()}.json`);
await writeFile(file, JSON.stringify(results, null, 2));
console.log(`\nresults: ${file}`);
server.close();

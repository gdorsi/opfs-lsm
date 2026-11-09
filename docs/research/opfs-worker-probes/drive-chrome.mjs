// Runs every probe in headless Chrome, P7 included, through the DevTools protocol.
// Start the server first: node docs/research/opfs-worker-probes/serve.mjs 8788
// node docs/research/opfs-worker-probes/drive-chrome.mjs [baseUrl] [chromePath]
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const base = process.argv[2] ?? "http://localhost:8788";
const chromePath = process.argv[3] ?? process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const resultsDir = fileURLToPath(new URL("results/", import.meta.url));
const port = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function newResult(prefix, before) {
  const files = await readdir(resultsDir).catch(() => []);
  return files.find((f) => f.startsWith(prefix) && !before.includes(f));
}

const profile = await mkdtemp(join(tmpdir(), "opfs-probe-"));
const chrome = spawn(chromePath, [
  "--headless=new",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--disable-gpu",
  "about:blank",
]);

try {
  const target = await waitFor(async () => {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => null);
    return list?.find((t) => t.type === "page");
  }, 15000, "a page target");

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  const bfcacheNotUsed = [];
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === "Page.backForwardCacheNotUsed") bfcacheNotUsed.push(msg.params);
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      pending.set(++id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;

  await send("Page.enable");
  await send("Runtime.enable");

  let before = await readdir(resultsDir).catch(() => []);
  await send("Page.navigate", { url: `${base}/?auto` });
  const main = await waitFor(() => newResult("chrome-", before), 600000, "P1–P6 results");
  console.log(`P1–P6: ${main}`);

  before = await readdir(resultsDir).catch(() => []);
  await send("Page.navigate", { url: `${base}/` });
  await waitFor(() => evaluate("document.readyState === 'complete' && !!document.getElementById('bfcache')"), 10000, "probe page");
  await evaluate("document.getElementById('bfcache').click()");
  await waitFor(() => evaluate("!!JSON.parse(localStorage.getItem('iq-p7') ?? 'null')?.away"), 20000, "the away page's check");
  const history = (await send("Page.getNavigationHistory")).result;
  await send("Page.navigateToHistoryEntry", { entryId: history.entries[history.currentIndex - 1].id });
  const p7 = await waitFor(() => newResult("chrome-p7-", before), 20000, "P7 result");
  console.log(`P7: ${p7}`);
  if (bfcacheNotUsed.length) {
    const file = join(resultsDir, `chrome-p7-reasons-${Date.now()}.json`);
    await writeFile(file, JSON.stringify(bfcacheNotUsed, null, 2));
    console.log(`P7 bfcache-not-used reasons: ${file}`);
  }
  ws.close();
} finally {
  chrome.kill();
  await sleep(1000);
  await rm(profile, { recursive: true, force: true }).catch(() => undefined);
}

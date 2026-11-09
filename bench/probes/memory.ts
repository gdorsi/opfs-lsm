/**
 * Two Chrome probes for the bounded-compaction-memory design. Chrome only.
 *
 *   node bench/probes/memory.ts [writable|wasm-drop]     (default: both)
 *
 * writable: does Chrome hold `createWritable` data in memory until close()?
 *   A SharedWorker writes 200 MiB to one OPFS file in 4 MiB chunks without
 *   closing. After each 50 MiB the probe prints process memory by Chrome
 *   process type and the size of the profile directory (what reached disk).
 *   Memory that grows with the writes means pending data is buffered in
 *   memory. A growing profile directory means it goes to a swap file.
 *
 * wasm-drop: does dropping a WebAssembly.Instance give its memory back?
 *   A SharedWorker instantiates kv's engine.wasm, grows its memory to
 *   300 MiB and touches every page, then drops every reference and the probe
 *   forces GC with HeapProfiler.collectGarbage.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { launchChrome, type Chrome, type MemoryNow, type Tab } from "../driver/chrome.ts";

const run = promisify(execFile);
const MiB = 1024 * 1024;
const WASM = path.resolve(import.meta.dirname, "../../packages/kv/wasm/engine.wasm");

const WASM_FUNCS = `
async function grow(mib) {
  const bytes = await (await fetch("/engine.wasm")).arrayBuffer();
  const module = await WebAssembly.compile(bytes);
  self.holder = { instance: await WebAssembly.instantiate(module, {}) };
  const memory = self.holder.instance.exports.memory;
  memory.grow(Math.ceil((mib * 1024 * 1024 - memory.buffer.byteLength) / 65536));
  const view = new Uint8Array(memory.buffer);
  for (let i = 0; i < view.length; i += 4096) view[i] = 1;
  return view.length;
}
function drop() {
  self.holder = null;
}
`;

const WORKER = `${WASM_FUNCS}
const call = {
  async noop() {},
  async open() {
    const root = await navigator.storage.getDirectory();
    const h = await root.getFileHandle("probe.bin", { create: true });
    self.writable = await h.createWritable();
    self.chunk = new Uint8Array(4 * 1024 * 1024);
    crypto.getRandomValues(self.chunk.subarray(0, 65536));
    for (let i = 65536; i < self.chunk.length; i += 65536) self.chunk.copyWithin(i, 0, 65536);
  },
  async write({ chunks }) {
    for (let i = 0; i < chunks; i++) await self.writable.write(self.chunk);
  },
  async close() {
    await self.writable.close();
    const root = await navigator.storage.getDirectory();
    await root.removeEntry("probe.bin");
  },
  grow: ({ mib }) => grow(mib),
  async drop() {
    drop();
  },
};
onconnect = (e) => {
  const port = e.ports[0];
  port.onmessage = async (m) => {
    try {
      port.postMessage({ ok: await call[m.data.cmd](m.data) });
    } catch (err) {
      port.postMessage({ error: String(err) });
    }
  };
};
`;

async function serve(): Promise<{ origin: string; close(): void }> {
  const server = createServer((req, res) => {
    const headers = { "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp", "cache-control": "no-store" };
    if (req.url === "/worker.js") res.writeHead(200, { ...headers, "content-type": "text/javascript" }).end(WORKER);
    else if (req.url === "/engine.wasm") res.writeHead(200, { ...headers, "content-type": "application/wasm" }).end(readFileSync(WASM));
    else res.writeHead(200, { ...headers, "content-type": "text/html" }).end("<!doctype html><title>probe</title>");
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => server.close() })),
  );
}

const mib = (n: number) => (n / MiB).toFixed(0).padStart(5);
/** The browser process and one renderer: `pid` when given, else the largest. Spare renderers come and go and would drown the signal. */
const procs = (m: MemoryNow, pid?: number) => {
  const renderers = m.processes.filter((p) => p.type === "renderer");
  const r = pid === undefined ? renderers.reduce((a, b) => (b.bytes > a.bytes ? b : a)) : renderers.find((p) => p.pid === pid);
  const browser = m.processes.find((p) => p.type === "browser");
  return `browser ${mib(browser?.bytes ?? 0).trim()}, renderer[${r?.pid ?? pid}] ${r ? mib(r.bytes).trim() : "exited"}`;
};
const heap = (m: MemoryNow) =>
  m.sharedWorker
    ? `SW heap used ${mib(m.sharedWorker.usedSize).trim()} total ${mib(m.sharedWorker.totalSize).trim()} backing ${m.sharedWorker.backingStorageSize === undefined ? "n/a" : mib(m.sharedWorker.backingStorageSize).trim()}`
    : "SW heap n/a";

async function profileMiB(chrome: Chrome): Promise<number> {
  const { stdout } = await run("du", ["-sk", chrome.profile]);
  return Number(stdout.split("\t")[0]) / 1024;
}

async function settled(chrome: Chrome): Promise<MemoryNow> {
  await sleep(500);
  return chrome.now();
}

async function writable(chrome: Chrome, tab: Tab): Promise<void> {
  console.log("\n== writable: 200 MiB in 4 MiB chunks, no close until the end (MiB)");
  const base = await settled(chrome);
  await tab.evaluate(`window.call({ cmd: "open" })`, 30_000);
  const row = async (label: string, m: MemoryNow) =>
    console.log(`${label.padEnd(22)} ${procs(m)}  profile dir ${(await profileMiB(chrome)).toFixed(0).padStart(5)}  ${heap(m)}`);
  await row("baseline", base);
  for (let written = 50; written <= 200; written += 50) {
    await tab.evaluate(`window.call({ cmd: "write", chunks: ${written === 50 ? 13 : 12} })`, 120_000);
    await row(`written ~${written} MiB`, await settled(chrome));
  }
  await tab.evaluate(`window.call({ cmd: "close" })`, 120_000);
  await row("after close()", await settled(chrome));
}

type Where = { name: string; grow: () => Promise<number>; drop: () => Promise<void>; alive: () => Promise<boolean> };

async function wasmDrop(chrome: Chrome, where: Where): Promise<void> {
  console.log(`\n== wasm-drop in the ${where.name}: instantiate engine.wasm, grow to 300 MiB, touch every page, drop (MiB)`);
  const base = await settled(chrome);
  console.log(`${"baseline".padEnd(22)} ${procs(base)}  ${heap(base)}`);
  const size = await where.grow();
  console.log(`memory.buffer.byteLength after grow: ${size / MiB} MiB`);
  const grown = await settled(chrome);
  const holder = grown.processes.filter((p) => p.type === "renderer").reduce((a, b) => (b.bytes > a.bytes ? b : a)).pid;
  console.log(`${"grown".padEnd(22)} ${procs(grown, holder)}  ${heap(grown)}`);
  await where.drop();
  const dropped = await settled(chrome);
  console.log(`${"dropped, no GC yet".padEnd(22)} ${procs(dropped, holder)}  ${heap(dropped)}`);
  await chrome.collectGarbage();
  const gc = await settled(chrome);
  console.log(`${"after collectGarbage".padEnd(22)} ${procs(gc, holder)}  ${heap(gc)}`);
  await sleep(3000);
  await chrome.collectGarbage();
  const last = await chrome.now();
  console.log(`${"3 s and GC again".padEnd(22)} ${procs(last, holder)}  ${heap(last)}`);
  console.log(`${where.name} still answers: ${await where.alive()}`);
}

const which = process.argv[2] ?? "all";
if (!["all", "writable", "wasm-drop"].includes(which)) throw new Error("usage: node bench/probes/memory.ts [writable|wasm-drop]");
const server = await serve();
const chrome = await launchChrome({ headless: true, onProgress: () => {} });
try {
  console.log(chrome.version);
  const tab = await chrome.openTab(`${server.origin}/`);
  await tab.evaluate(
    `(window.call = (m) => new Promise((res, rej) => { const w = (window.w ??= new SharedWorker("/worker.js")); w.port.onmessage = (e) => (e.data.error ? rej(new Error(e.data.error)) : res(e.data.ok)); w.port.postMessage(m); }), window.call({ cmd: "noop" }))`,
    30_000,
  );
  if (which === "all" || which === "writable") await writable(chrome, tab);
  if (which === "all" || which === "wasm-drop") {
    await wasmDrop(chrome, {
      name: "SharedWorker",
      grow: () => tab.evaluate<number>(`window.call({ cmd: "grow", mib: 300 })`, 60_000),
      drop: async () => void (await tab.evaluate(`window.call({ cmd: "drop" })`, 30_000)),
      alive: () => tab.evaluate<boolean>(`window.call({ cmd: "noop" }).then(() => true)`, 10_000).catch(() => false),
    });
    const page = await chrome.openTab(`${server.origin}/`);
    await wasmDrop(chrome, {
      name: "tab",
      grow: () => page.evaluate<number>(`${WASM_FUNCS}; grow(300)`, 60_000),
      drop: async () => void (await page.evaluate(`${WASM_FUNCS}; drop()`, 30_000)),
      alive: () => page.evaluate<boolean>(`1 + 1 === 2`, 10_000).catch(() => false),
    });
  }
} finally {
  await chrome.close();
  server.close();
}

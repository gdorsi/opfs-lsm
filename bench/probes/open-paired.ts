/**
 * Cold `openDb` of two builds of `@opfs-lsm/kv`, paired, and the browser calls of one open.
 *
 *   node bench/probes/open-paired.ts --a <packages/kv of one checkout> [--b <of another>] [--rounds 30] [--wait 3000]
 *
 * Each build fills a database of its own with 100,000 entries and settles it. A round then opens each database once,
 * in a fresh tab, after every SharedWorker has exited and `--wait` ms later, and the order rotates per round. The
 * probe prints the median open and first `get` per build, and the median of the per-round difference from the first
 * build. Give the first build twice (`--b` left out) to see how far two runs of one build differ.
 *
 * It then prints one open of the last build as a timeline of its browser calls: locks, OPFS, IndexedDB, wasm. The
 * page loads each build's `dist` as it is, so build the packages first. A build is not bundled here, which costs
 * the import and not the timed open.
 */
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { launchChrome } from "../driver/chrome.ts";
import { serve } from "../driver/serve.ts";

const PAGE = `<!doctype html><meta charset="utf-8"><script type="module">
const query = new URLSearchParams(location.search);
const build = query.get("build");
const calls = [];
let from = 0;
function watch(target, method, label = method) {
  const call = target[method];
  target[method] = function (...args) {
    const start = performance.now() - from;
    const what = typeof args[0] === "string" ? label + " " + args[0] : args[0] instanceof URL ? label + " " + args[0].pathname.split("/").pop() : label;
    const done = () => calls.push([what, start, performance.now() - from]);
    const result = call.apply(this, args);
    if (result instanceof IDBRequest) result.addEventListener("success", done);
    else if (typeof result?.then === "function") result.then(done, done);
    else done();
    return result;
  };
}
if (query.has("trace")) {
  watch(navigator.storage, "getDirectory");
  watch(FileSystemDirectoryHandle.prototype, "getDirectoryHandle");
  watch(FileSystemDirectoryHandle.prototype, "getFileHandle");
  watch(FileSystemFileHandle.prototype, "getFile");
  watch(Blob.prototype, "arrayBuffer");
  watch(LockManager.prototype, "request", "lock");
  watch(IDBFactory.prototype, "open", "indexedDB.open");
  watch(IDBDatabase.prototype, "transaction", "transaction");
  watch(IDBObjectStore.prototype, "get", "get");
  watch(IDBObjectStore.prototype, "getAll", "getAll");
  watch(WebAssembly, "compile", "WebAssembly.compile");
  watch(window, "fetch");
}
const kv = await import("/" + build + "/dist/index.js");
const name = "open-paired-" + build;
const ENTRIES = 100000;
function keyOf(i) {
  const key = new Uint8Array(16);
  new DataView(key.buffer).setUint32(0, Math.imul(i, 2654435761) >>> 0);
  new DataView(key.buffer).setUint32(4, i);
  return key;
}
window.fill = async () => {
  const { settle } = await import("/" + build + "/dist/testing.js");
  const db = await kv.openDb({ name, reserveBytes: 0 });
  for (let at = 0; at < ENTRIES; at += 1000) {
    await db.batch((tx) => {
      for (let i = at; i < at + 1000; i++) {
        const value = new Uint8Array(100);
        crypto.getRandomValues(value.subarray(0, 50));
        tx.put(keyOf(i), value);
      }
    });
  }
  await settle(db);
  await db.close();
};
window.open1 = async (id) => {
  calls.length = 0;
  from = performance.now();
  const db = await kv.openDb({ name, reserveBytes: 0 });
  const opened = performance.now();
  const value = await db.get(keyOf(id));
  const read = performance.now();
  await db.close();
  return { open: opened - from, get: read - opened, found: value?.length === 100, calls: calls.filter((c) => c[1] >= 0 && c[1] <= read - from) };
};
window.ready = true;
</script>`;

type Opened = { open: number; get: number; found: boolean; calls: [what: string, start: number, end: number][] };

const { values } = parseArgs({ options: { a: { type: "string" }, b: { type: "string" }, rounds: { type: "string", default: "30" }, wait: { type: "string", default: "3000" } } });
if (!values.a) throw new Error("usage: node bench/probes/open-paired.ts --a <packages/kv> [--b <packages/kv>] [--rounds N] [--wait MS]");
const builds = [values.a, values.b ?? values.a];
const rounds = Number(values.rounds);
const wait = Number(values.wait);

const root = mkdtempSync(path.join(tmpdir(), "open-paired-"));
writeFileSync(path.join(root, "index.html"), PAGE);
const distinct = [...new Set(builds.map((dir) => path.resolve(dir)))];
distinct.forEach((dir, i) => symlinkSync(dir, path.join(root, `build${i}`)));
const buildOf = (arm: number) => `build${distinct.indexOf(path.resolve(builds[arm]!))}`;

const server = await serve({ "/": root, "/data/": root });
const chrome = await launchChrome({ headless: true, onProgress: () => {} });
const READY = `new Promise((resolve) => { const timer = setInterval(() => { if (window.ready) { clearInterval(timer); resolve(1); } }, 5); })`;

async function inTab<T>(build: string, call: string, trace = false): Promise<T> {
  const tab = await chrome.openTab(`${server.origin}/index.html?build=${build}${trace ? "&trace" : ""}`);
  try {
    await tab.evaluate(READY, 30_000);
    return await tab.evaluate<T>(call, 120_000);
  } finally {
    await tab.close();
  }
}

async function coldOpen(arm: number, id: number, trace = false): Promise<Opened> {
  await chrome.sharedWorkersGone(30_000);
  await sleep(wait);
  return inTab<Opened>(buildOf(arm), `window.open1(${id})`, trace);
}

const quantile = (xs: readonly number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * q))]!;
const ms = (x: number) => x.toFixed(2);

try {
  for (let i = 0; i < distinct.length; i++) await inTab(`build${i}`, "window.fill()");
  const opens: number[][] = builds.map(() => []);
  const gets: number[][] = builds.map(() => []);
  const differences: number[][] = builds.map(() => []);
  let missing = 0;
  for (let round = 0; round < rounds; round++) {
    const row: number[] = [];
    for (let k = 0; k < builds.length; k++) {
      const arm = (k + round) % builds.length;
      const opened = await coldOpen(arm, 1 + round * 97);
      if (!opened.found) missing++;
      opens[arm]!.push(opened.open);
      gets[arm]!.push(opened.get);
      row[arm] = opened.open;
    }
    builds.forEach((_, arm) => differences[arm]!.push(row[arm]! - row[0]!));
  }
  builds.forEach((dir, arm) => {
    const d = differences[arm]!;
    console.log(
      `${arm === 0 ? "a" : "b"} ${dir}: open ${ms(quantile(opens[arm]!, 0.5))} ms (quartiles ${ms(quantile(opens[arm]!, 0.25))} to ${ms(quantile(opens[arm]!, 0.75))}), ` +
        `first get ${ms(quantile(gets[arm]!, 0.5))} ms` +
        (arm === 0 ? "" : `, open against a per round ${ms(quantile(d, 0.5))} ms (quartiles ${ms(quantile(d, 0.25))} to ${ms(quantile(d, 0.75))})`),
    );
  });
  console.log(`${rounds} rounds, ${rounds * builds.length} opens, ${missing} reads without their value, ${chrome.version}`);

  const traced = await coldOpen(builds.length - 1, 1, true);
  console.log(`\none open of b, ${ms(traced.open)} ms, then its first get, ${ms(traced.get)} ms: start, end and length of each browser call, ms`);
  for (const [what, start, end] of traced.calls.sort((x, y) => x[1] - y[1])) console.log(`${ms(start).padStart(7)} ${ms(end).padStart(7)} ${ms(end - start).padStart(6)}  ${what}`);
  if (missing > 0) process.exitCode = 1;
} finally {
  await chrome.close();
  await server.close();
  rmSync(root, { recursive: true, force: true });
}

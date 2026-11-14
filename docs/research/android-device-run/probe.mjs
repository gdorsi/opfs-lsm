/**
 * Open a page on the device that reports which APIs kv needs are present,
 * then calls openDb, puts one key and reads it back.
 *
 *   ANDROID_SERIAL=<serial> ANDROID_BROWSER=<package> node docs/research/android-device-run/probe.mjs
 *
 * Needs `pnpm --filter @opfs-lsm/kv build` first: the page imports kv's dist.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ADB = process.env.ANDROID_ADB ?? "adb";
const SERIAL = process.env.ANDROID_SERIAL;
const PKG = process.env.ANDROID_BROWSER ?? "org.chromium.chrome";
if (!SERIAL) {
  console.error("probe: set ANDROID_SERIAL");
  process.exit(2);
}
const kvRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/kv");
const MIME = { ".js": "text/javascript", ".wasm": "application/wasm" };

const page = `<!doctype html><meta charset="utf-8"><title>kv device probe</title><pre id="o">probing</pre>
<script type="module">
const r = { ua: navigator.userAgent, secure: isSecureContext, visibility: document.visibilityState, cores: navigator.hardwareConcurrency, deviceMemory: navigator.deviceMemory ?? null };
const step = async (name, fn) => { try { r[name] = await fn(); } catch (e) { r[name] = "ERR " + (e?.name ?? "") + ": " + (e?.message ?? e); } };
await step("randomUUID", () => typeof crypto.randomUUID);
await step("locks", () => typeof navigator.locks?.request);
await step("broadcastChannel", () => typeof BroadcastChannel);
await step("wasm", () => typeof WebAssembly?.instantiateStreaming);
await step("sharedWorker", () => typeof SharedWorker);
await step("quotaMB", async () => Math.round((await navigator.storage.estimate()).quota / 1e6));
await step("opfsInPage", async () => { const d = await navigator.storage.getDirectory(); const h = await d.getFileHandle("probe-page", { create: true }); const w = await h.createWritable(); await w.write(new Uint8Array(3)); await w.close(); const n = (await h.getFile()).size; await d.removeEntry("probe-page"); return "createWritable ok, size " + n; });
await step("opfsInSharedWorker", () => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("no message in 8 s")), 8000); const w = new SharedWorker("/worker.js", { type: "module", name: "probe" }); w.onerror = (e) => { clearTimeout(t); rej(new Error("worker error " + (e.message ?? ""))); }; w.port.onmessage = (e) => { clearTimeout(t); res(e.data); }; w.port.start(); }));
await step("openDb", async () => { const { openDb } = await import("/dist/index.js"); const enc = new TextEncoder(); const db = await openDb({ name: "device-probe" }); await db.put(enc.encode("k"), enc.encode("v")); const got = new TextDecoder().decode(await db.get(enc.encode("k"))); await db.close(); return "put then get returned " + got; });
document.getElementById("o").textContent = JSON.stringify(r, null, 2);
await fetch("/result", { method: "POST", body: JSON.stringify(r) });
</script>`;

const worker = `self.onconnect = async (e) => {
  try { const d = await navigator.storage.getDirectory(); const h = await d.getFileHandle("probe-worker", { create: true }); const w = await h.createWritable(); await w.write(new Uint8Array(4096)); await w.close(); const n = (await h.getFile()).size; await d.removeEntry("probe-worker"); e.ports[0].postMessage("createWritable ok, size " + n); }
  catch (err) { e.ports[0].postMessage("ERR " + err.name + ": " + err.message); }
};`;

const server = http.createServer((req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  if (req.method === "POST" && url === "/result") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.end("ok");
      console.log(JSON.stringify(JSON.parse(body), null, 2));
      process.exit(0);
    });
    return;
  }
  if (url === "/" || url === "/worker.js") {
    res.writeHead(200, { "content-type": url === "/" ? "text/html; charset=utf-8" : "text/javascript", "cache-control": "no-store" });
    res.end(url === "/" ? page : worker);
    return;
  }
  const file = path.join(kvRoot, path.normalize(url));
  if (!file.startsWith(kvRoot) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(file).pipe(res);
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  const adb = (...args) => execFileSync(ADB, ["-s", SERIAL, ...args], { encoding: "utf8", timeout: 20_000 });
  adb("reverse", `tcp:${port}`, `tcp:${port}`);
  // A fresh Chrome install shows a first-run screen and never loads the URL.
  if (/chrom/.test(PKG)) adb("shell", "echo 'chrome --disable-fre' > /data/local/tmp/chrome-command-line");
  adb("shell", `am force-stop ${PKG}; am start -a android.intent.action.VIEW -d 'http://127.0.0.1:${port}/' ${PKG}`);
});
setTimeout(() => {
  console.error("probe: the page did not report within 60 s");
  process.exit(1);
}, 60_000);

/**
 * Where does Android schedule a SharedWorker? Open a tab whose SharedWorker
 * spins for 12 s for each tab that connects while the pages idle, and print each
 * browser process's CPU use and cpuset. Then open a second tab on the same
 * worker, which puts the first tab in the background, and print them again.
 *
 *   ANDROID_SERIAL=<serial> node docs/research/android-device-run/worker-cpuset.mjs
 */
import { execFileSync } from "node:child_process";
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

const ADB = process.env.ANDROID_ADB ?? "adb";
const SERIAL = process.env.ANDROID_SERIAL;
const PKG = process.env.ANDROID_BROWSER ?? "org.chromium.chrome";
if (!SERIAL) {
  console.error("worker-cpuset: set ANDROID_SERIAL");
  process.exit(2);
}
const adb = (...args) => execFileSync(ADB, ["-s", SERIAL, ...args], { encoding: "utf8", timeout: 20_000 });

const page = `<!doctype html><meta charset="utf-8"><title>worker cpuset</title><pre id="o">worker spinning</pre>
<script type="module">
const w = new SharedWorker("/worker.js", { type: "module", name: "spin" });
w.port.onmessage = (e) => { document.getElementById("o").textContent = "worker done: " + e.data; };
w.port.start();
</script>`;
const SPIN_MS = 12_000;
const worker = `self.onconnect = (e) => { const until = Date.now() + ${SPIN_MS}; let n = 0; while (Date.now() < until) n++; e.ports[0].postMessage(n); };`;

const server = http.createServer((req, res) => {
  const isWorker = req.url === "/worker.js";
  res.writeHead(200, { "content-type": isWorker ? "text/javascript" : "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(isWorker ? worker : page);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
adb("reverse", `tcp:${port}`, `tcp:${port}`);
if (/chrom/.test(PKG)) adb("shell", "echo 'chrome --disable-fre' > /data/local/tmp/chrome-command-line");
const open = (tab) => adb("shell", `am start -a android.intent.action.VIEW -d 'http://127.0.0.1:${port}/?tab=${tab}' ${PKG}`);
adb("shell", `am force-stop ${PKG}`);
open(1);

const locked = adb("shell", "dumpsys window").includes("isKeyguardShowing=true");
console.log(`device ${locked ? "locked" : "unlocked"}, cpusets: top-app ${adb("shell", "cat /dev/cpuset/top-app/cpus").trim()}, background ${adb("shell", "cat /dev/cpuset/background/cpus").trim()}`);
async function sample(label) {
  console.log(label);
  const rows = adb(
    "shell",
    `top -b -n 1 -d 1 -o PID,%CPU,CMDLINE | grep '${PKG}' | grep -v grep | while read pid cpu name; do echo "$cpu% pid $pid $(cat /proc/$pid/cpuset 2>/dev/null) cpus $(grep Cpus_allowed_list /proc/$pid/status 2>/dev/null | cut -f2) $name"; done`,
  );
  for (const row of rows.trim().split("\n")) console.log(`  ${row.replace(/:org\.chromium\.content\.app\.\S+/, "")}`);
}
await sleep(SPIN_MS / 3);
await sample("one tab, in the foreground");
open(2);
const untilSecondSpinIsRunning = SPIN_MS - 2000;
await sleep(untilSecondSpinIsRunning);
await sample("second tab opened, first tab in the background");
await sleep(2000);
await sample("again 2 s later");
adb("shell", `am force-stop ${PKG}`);
adb("reverse", "--remove", `tcp:${port}`);
process.exit(0);

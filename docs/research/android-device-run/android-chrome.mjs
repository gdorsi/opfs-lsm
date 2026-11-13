#!/usr/bin/env node
/**
 * A stand-in for desktop Chrome that runs the browser on an Android device.
 * Set it as CHROME_PATH and the Chrome harnesses (two-tab, bench, kill-chrome)
 * drive the device over adb with their own assertions unchanged.
 *
 *   ANDROID_SERIAL   device serial from `adb devices` (required)
 *   ANDROID_BROWSER  package to launch, default org.chromium.chrome
 *   ANDROID_FLAGS    "harness" (default) passes the harness's Chrome flags to the
 *                    device browser, "none" passes only the two flags this file needs
 *   ANDROID_CLEAR    "1" wipes the browser's data before each launch (a fresh profile)
 *   ANDROID_ADB      adb binary, default `adb`
 *   ANDROID_SHIM_LOG file that receives one line per step
 */
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ADB = process.env.ANDROID_ADB ?? "adb";
const SERIAL = process.env.ANDROID_SERIAL;
const PKG = process.env.ANDROID_BROWSER ?? "org.chromium.chrome";
const LOG = process.env.ANDROID_SHIM_LOG;
if (!SERIAL) {
  console.error("android-chrome: set ANDROID_SERIAL");
  process.exit(2);
}
// A Chrome build has one devtools socket and reads a flags file. A WebView app has a socket per process and no flags.
const isChrome = /chrom/.test(PKG);

const log = (line) => {
  if (LOG) appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
};
// An adb client sometimes fails to reach the adb server ("cannot connect to daemon").
const adb = (...args) => {
  for (let attempt = 1; ; attempt++) {
    try {
      return execFileSync(ADB, ["-s", SERIAL, ...args], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      if (attempt === 3) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    }
  }
};
const shell = (cmd) => adb("shell", cmd);

const argv = process.argv.slice(2);
const value = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const profile = value("user-data-dir");
const url = argv.findLast((a) => !a.startsWith("--")) ?? "about:blank";
const HOST_ONLY = ["--user-data-dir", "--remote-debugging-port", "--headless", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"];
const harnessFlags = argv.filter((a) => a.startsWith("--") && !HOST_ONLY.some((h) => a === h || a.startsWith(`${h}=`)));

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const debugPort = Number(value("remote-debugging-port") ?? 0) || (await freePort());

const reversed = new Set();
const reverse = (port) => {
  if (reversed.has(port)) return;
  adb("reverse", `tcp:${port}`, `tcp:${port}`);
  reversed.add(port);
  log(`reverse ${port}`);
};
const reverseParentPorts = () => {
  let out = "";
  try {
    out = execFileSync("lsof", ["-nP", "-a", "-p", String(process.ppid), "-iTCP", "-sTCP:LISTEN"], { encoding: "utf8" });
  } catch {
    return;
  }
  for (const m of out.matchAll(/:(\d+) \(LISTEN\)/g)) reverse(Number(m[1]));
};

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const watchdogPidFile = path.join(tmpdir(), `android-chrome-${SERIAL}.watchdog`);
async function waitForPreviousWatchdog() {
  let previous = 0;
  try {
    previous = Number(readFileSync(watchdogPidFile, "utf8"));
  } catch {}
  while (previous > 0 && alive(previous)) await sleep(50);
}
function stopBrowserWhenThisProcessIsKilled() {
  const watchdog = spawn(
    "sh",
    ["-c", 'while kill -0 "$1" 2>/dev/null; do sleep 0.1; done; "$2" -s "$3" shell am force-stop "$4"; "$2" -s "$3" forward --remove "tcp:$5"', "watchdog", String(process.pid), ADB, SERIAL, PKG, String(debugPort)],
    { detached: true, stdio: "ignore" },
  );
  watchdog.unref();
  writeFileSync(watchdogPidFile, String(watchdog.pid));
}
await waitForPreviousWatchdog();
stopBrowserWhenThisProcessIsKilled();

shell(`am force-stop ${PKG}`);
// One relaunch after a browser crash never answered on the forwarded socket. The cause was not confirmed.
// This waits until the old process and its socket are gone.
for (const until = Date.now() + 15_000; isChrome && Date.now() < until; ) {
  if (shell(`pidof ${PKG}; grep -a -c '@chrome_devtools_remote$' /proc/net/unix; true`).trim() === "0") break;
  shell(`am force-stop ${PKG}`);
  await sleep(200);
}
if (process.env.ANDROID_CLEAR === "1") shell(`pm clear ${PKG}`);
for (const line of execFileSync(ADB, ["forward", "--list"], { encoding: "utf8" }).split("\n")) {
  const [serial, local, remote] = line.split(/\s+/);
  if (serial === SERIAL && remote?.includes("devtools_remote")) adb("forward", "--remove", local);
}
adb("reverse", "--remove-all");

const urlPort = /^http:\/\/127\.0\.0\.1:(\d+)\//.exec(url)?.[1];
if (urlPort) reverse(Number(urlPort));
reverseParentPorts();

if (isChrome) {
  // --disable-fre skips the first-run screen. --no-restore-state keeps a relaunch from reloading the killed tabs.
  const flags = ["--disable-fre", "--no-restore-state", ...((process.env.ANDROID_FLAGS ?? "harness") === "harness" ? harnessFlags : [])];
  shell(`echo 'chrome ${flags.join(" ")}' > /data/local/tmp/chrome-command-line`);
  log(`flags ${flags.join(" ")}`);
}
shell(`am start -a android.intent.action.VIEW -d '${url}' ${PKG}`);
log(`started ${PKG} ${url}`);

const socketPattern = isChrome ? /@(chrome_devtools_remote)\s*$/m : /@(webview_devtools_remote_\d+)\s*$/m;
let socket;
for (const until = Date.now() + 20_000; !socket; ) {
  socket = socketPattern.exec(shell("cat /proc/net/unix"))?.[1];
  if (!socket && Date.now() > until) throw new Error("no devtools socket on the device");
  if (!socket) await sleep(150);
}
adb("forward", `tcp:${debugPort}`, `localabstract:${socket}`);
log(`forward ${debugPort} -> ${socket}`);
for (const until = Date.now() + 15_000; ; ) {
  const answered = await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false);
  if (answered) break;
  if (Date.now() > until) throw new Error("the device browser did not answer on its devtools socket");
  await sleep(150);
}
if (profile) writeFileSync(path.join(profile, "DevToolsActivePort"), `${debugPort}\n/devtools/browser\n`);

// The pid, not the name: a crashing renderer forks a crash handler that has the browser's process name.
const browserPid = shell(`pidof ${PKG}`).trim().split(/\s+/)[0];
log(`browser pid ${browserPid}`);
const exitWhenBrowserDies = () => {
  const watcher = spawn(ADB, ["-s", SERIAL, "shell", `while [ -d /proc/${browserPid} ]; do sleep 1; done; echo gone`], { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  watcher.stdout.on("data", (chunk) => (out += chunk));
  watcher.on("exit", () => {
    if (!out.includes("gone")) return void setTimeout(exitWhenBrowserDies, 1000);
    log("browser gone");
    process.exit(0);
  });
};
exitWhenBrowserDies();
setInterval(reverseParentPorts, 250);
process.on("SIGTERM", () => process.exit(0));

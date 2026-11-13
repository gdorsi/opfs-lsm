/**
 * Run the Chrome proofs on an Android device, start to finish: pick the
 * device, install Chromium when asked, keep the screen awake, run each proof
 * through android-chrome.mjs, collect the logs, and put the device back.
 *
 *   node docs/research/android-device-run/run.mjs [--install-chromium] [--chromium-revision N] [--keep-browser]
 *        [--only probe,two-tab,...] [--skip bench-kv,kill] [--out DIR]
 *
 * Exit 0 when every step that ran passed.
 */
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const { values: opts } = parseArgs({
  options: {
    "install-chromium": { type: "boolean", default: false },
    "chromium-revision": { type: "string" },
    "keep-browser": { type: "boolean", default: false },
    only: { type: "string" },
    skip: { type: "string", default: "" },
    out: { type: "string" },
  },
});
const ADB = process.env.ANDROID_ADB ?? "adb";
const PKG = process.env.ANDROID_BROWSER ?? "org.chromium.chrome";
const SNAPSHOTS = "https://storage.googleapis.com/chromium-browser-snapshots/Android_Arm64";

const attached = execFileSync(ADB, ["devices"], { encoding: "utf8", timeout: 20_000 })
  .split("\n")
  .map((l) => /^(\S+)\tdevice$/.exec(l)?.[1])
  .filter(Boolean);
const SERIAL = process.env.ANDROID_SERIAL ?? (attached.length === 1 ? attached[0] : undefined);
if (!SERIAL || !attached.includes(SERIAL)) {
  console.error(`run: set ANDROID_SERIAL to one of the attached devices: ${attached.join(", ") || "none"}`);
  process.exit(2);
}
const adb = (...args) => execFileSync(ADB, ["-s", SERIAL, ...args], { encoding: "utf8", timeout: 600_000, stdio: ["ignore", "pipe", "pipe"] });
const shell = (cmd) => adb("shell", cmd).trim();
const deviceAttached = () => {
  try {
    return adb("get-state").trim() === "device";
  } catch {
    return false;
  }
};

const out = path.resolve(opts.out ?? path.join(here, "results", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)));
mkdirSync(out, { recursive: true });

async function installChromium() {
  const revision = opts["chromium-revision"] ?? (await (await fetch(`${SNAPSHOTS}/LAST_CHANGE`)).text()).trim();
  const cache = path.join(here, "results", `chromium-${revision}`);
  const apk = path.join(cache, "ChromePublic.apk");
  if (!existsSync(apk)) {
    mkdirSync(cache, { recursive: true });
    console.log(`downloading Chromium snapshot ${revision} (about 440 MB)`);
    const zip = path.join(cache, "chrome-android.zip");
    const res = await fetch(`${SNAPSHOTS}/${revision}/chrome-android.zip`);
    if (!res.ok) throw new Error(`snapshot download: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(zip));
    execFileSync("unzip", ["-o", "-q", "-j", zip, "chrome-android/apks/ChromePublic.apk", "-d", cache]);
    rmSync(zip);
  }
  console.log(adb("install", "-r", apk).trim());
}

const env = {
  ...process.env,
  ANDROID_SERIAL: SERIAL,
  ANDROID_ADB: ADB,
  ANDROID_BROWSER: PKG,
  CHROME_PATH: path.join(here, "android-chrome.mjs"),
  ANDROID_SHIM_LOG: path.join(out, "shim.log"),
  VERIFY_OPFS_ARTIFACTS: path.join(out, "artifacts"),
};
const drive = (feature) => [".agents/skills/verify-opfs-lsm/bin/verify-opfs-lsm", "drive", feature];
const KINDS_OBSERVABLE_ON_ANDROID = "close-worker,kill-browser,browser-crash,quota";
const STEPS = [
  { id: "probe", timeoutMinutes: 2, cmd: ["node", path.join(here, "probe.mjs")] },
  { id: "two-tab", timeoutMinutes: 3, cmd: drive("two-tab"), env: { ANDROID_CLEAR: "1" } },
  { id: "two-tab-nobc", timeoutMinutes: 3, cmd: drive("two-tab-nobc"), env: { ANDROID_CLEAR: "1" } },
  { id: "two-tab-no-flags", timeoutMinutes: 5, cmd: drive("two-tab"), env: { ANDROID_CLEAR: "1", ANDROID_FLAGS: "none", TWO_TAB_REPEAT: "3" } },
  { id: "two-tab-local", timeoutMinutes: 3, cmd: drive("two-tab-local"), env: { ANDROID_CLEAR: "1" } },
  { id: "bench-smoke", timeoutMinutes: 20, cmd: ["node", "bench/cli.ts", "smoke"], env: { ANDROID_CLEAR: "1" }, bench: true },
  { id: "bench-kv", timeoutMinutes: 30, cmd: ["node", "bench/cli.ts", "run", "kv/", "--size", "small", "--reps", "1", "--contenders", "kv"], env: { ANDROID_CLEAR: "1" }, bench: true },
  {
    id: "kill",
    timeoutMinutes: 30,
    cmd: ["pnpm", "--filter", "@opfs-lsm/kv", "exec", "tsx", "scripts/kill-chrome.ts", "--iterations", "10", "--kinds", KINDS_OBSERVABLE_ON_ANDROID, "--keep-going", "--artifacts", path.join(out, "kill")],
    clearOnce: true,
  },
];
const only = opts.only?.split(",");
const skip = opts.skip.split(",");
const steps = STEPS.filter((s) => (only ? only.includes(s.id) : !skip.includes(s.id)));

function runStep(step) {
  return new Promise((resolve) => {
    const log = createWriteStream(path.join(out, `${step.id}.log`));
    const child = spawn(step.cmd[0], step.cmd.slice(1), { cwd: root, env: { ...env, ...step.env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    const timer = setTimeout(() => {
      log.write(`\nrun: stopped after ${step.timeoutMinutes} minutes\n`);
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, step.timeoutMinutes * 60_000);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      log.end();
      resolve(signal ? `stopped (${signal})` : code === 0 ? "pass" : `exit ${code}`);
    });
  });
}

const benchResults = path.join(root, "bench/results");
const benchRecords = () => (existsSync(benchResults) ? readdirSync(benchResults) : []);
// bench stamps each record with the CPU and OS of the machine that runs the CLI, so `bench compare` would read these as desktop runs.
function moveDeviceBenchRecordsOut(before, stepId) {
  for (const f of benchRecords()) {
    if (!before.has(f)) renameSync(path.join(benchResults, f), path.join(out, `${stepId}-${f}`));
  }
}

const stayOn = shell("settings get global stay_on_while_plugged_in");
let installed = false;
let locked = false;
const results = [];
try {
  if (!shell(`pm list packages ${PKG}`).includes(PKG)) {
    if (!opts["install-chromium"] || PKG !== "org.chromium.chrome") {
      throw new Error(`${PKG} is not installed on ${SERIAL}. Install it, or pass --install-chromium for the Chromium snapshot.`);
    }
    await installChromium();
    installed = true;
  }
  const version = /versionName=(\S+)/.exec(shell(`dumpsys package ${PKG}`))?.[1];
  const device = `${shell("getprop ro.product.model")}, Android ${shell("getprop ro.build.version.release")}, ${PKG} ${version}`;
  console.log(`${device}\nlogs: ${out}`);
  // Keeps the screen on while USB is attached, so the phone does not doze during the run.
  shell("svc power stayon usb; input keyevent KEYCODE_WAKEUP");
  // Behind the lock screen Android keeps the browser in the background cpuset.
  locked = shell("dumpsys window").includes("isKeyguardShowing=true");
  if (locked) console.log(`the device is locked: pass and fail are valid, timings are not (background cpus ${shell("cat /dev/cpuset/background/cpus")})`);

  for (const step of steps) {
    if (!deviceAttached()) {
      console.log(`${SERIAL} is no longer attached, stopping`);
      break;
    }
    const benchRecordsBefore = new Set(benchRecords());
    if (step.clearOnce) shell(`am force-stop ${PKG}; pm clear ${PKG}`);
    const started = Date.now();
    process.stdout.write(`${step.id} ... `);
    const result = await runStep(step);
    console.log(`${result} (${Math.round((Date.now() - started) / 1000)} s)`);
    results.push({ step: step.id, result });
    if (step.bench) moveDeviceBenchRecordsOut(benchRecordsBefore, step.id);
  }
  writeFileSync(path.join(out, "summary.json"), JSON.stringify({ device, serial: SERIAL, locked, results }, null, 2) + "\n");
} finally {
  try {
    shell(`am force-stop ${PKG}; rm -f /data/local/tmp/chrome-command-line`);
    shell(`settings put global stay_on_while_plugged_in ${stayOn === "null" ? 0 : stayOn}`);
    adb("reverse", "--remove-all");
    if (installed && !opts["keep-browser"]) console.log(`uninstall ${PKG}: ${adb("uninstall", PKG).trim()}`);
  } catch (err) {
    console.error(`the device was not restored: ${String(err.message).split("\n")[0]}`);
  }
}
const failed = results.filter((r) => r.result !== "pass");
const skipped = steps.length - results.length;
if (failed.length === 0 && skipped === 0) console.log(`\nall ${results.length} steps passed`);
else console.log(`\n${failed.length} of ${results.length} steps failed${failed.length ? `: ${failed.map((f) => f.step).join(", ")}` : ""}${skipped ? `, ${skipped} did not run` : ""}`);
process.exit(failed.length === 0 && skipped === 0 ? 0 : 1);

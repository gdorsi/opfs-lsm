// Starts the docs site or an example app as a dev server that outlives the shell that started it.
//
//   pnpm dev <app> [start|stop|restart]
//
// <app> is `site` or a folder under examples/. `start` reuses this checkout's server when it still answers, and
// otherwise builds the app's workspace packages, starts the server detached, and prints its URL and log file.
// Each checkout keeps its own servers under .scratch/dev/, so two worktrees never share one.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fail, resolveApp, root } from "./apps.mjs";

const [app, action = "start"] = process.argv.slice(2);
const START_TIMEOUT_MS = 240_000;

const { pkg, site } = resolveApp(app, "pnpm dev <app> [start|stop|restart]");
const dir = join(root, ".scratch", "dev");
const statePath = join(dir, `${app}.json`);
const logPath = join(dir, `${app}.log`);
const lockPath = join(dir, `${app}.lock`);

const readState = () => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : undefined);
const writeState = (state) => writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
const readLog = () => (existsSync(logPath) ? readFileSync(logPath, "utf8") : "");
const tail = (lines = 15) => readLog().trimEnd().split("\n").slice(-lines).join("\n");
// eslint-disable-next-line no-control-regex
const logUrl = () => readLog().replace(/\x1b\[[0-9;]*m/g, "").match(/Local:\s+(https?:\/\/\S+)/)?.[1];

function alive(pid) {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function answers(url) {
  if (!url) return false;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

/** One start at a time per app and checkout. The lock of a process that died is taken over. */
function lock() {
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(lockPath, String(process.pid), { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const holder = Number(readFileSync(lockPath, "utf8"));
    if (alive(holder)) fail(`pnpm dev ${app} is already running in pid ${holder}. Run this again once it is done.`);
    writeFileSync(lockPath, String(process.pid));
  }
  process.on("exit", () => rmSync(lockPath, { force: true }));
}

function stop() {
  const state = readState();
  if (state && alive(state.pid)) {
    // The server runs in its own process group: pnpm, then the dev server under it.
    try {
      process.kill(-state.pid, "SIGTERM");
    } catch {
      process.kill(state.pid, "SIGTERM");
    }
    console.log(`stopped ${app} (pid ${state.pid})`);
  }
  rmSync(statePath, { force: true });
}

function report(state, how) {
  console.log(`${app} ${how}: ${state.url}\nlog: ${state.log}\nstop: pnpm dev ${app} stop`);
}

async function start() {
  const state = readState();
  if (state && alive(state.pid)) {
    // A start that was interrupted leaves a server whose URL is only in its log.
    const url = state.url ?? logUrl();
    if (await answers(url)) {
      if (!state.url) writeState({ ...state, url });
      return report({ ...state, url }, "already running");
    }
  }
  if (state) {
    const what = alive(state.pid) ? "does not answer, so it is restarted" : "had exited";
    console.log(`The last ${app} server (pid ${state.pid}) ${what}. Its log ended with:\n${tail()}\n`);
  }
  stop();

  const log = openSync(logPath, "w");
  const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
  if (!site) {
    // Examples import the packages' dist, so build what this app depends on first.
    const built = spawnSync("pnpm", ["--filter", `${pkg}^...`, "run", "build"], { cwd: root, stdio: ["ignore", log, log], env });
    if (built.status !== 0) fail(`Building the packages ${app} uses failed. The log ends with:\n${tail()}\nlog: ${logPath}`);
  }
  const child = spawn("pnpm", ["--filter", pkg, "run", "dev"], { cwd: root, detached: true, stdio: ["ignore", log, log], env });
  child.unref();
  closeSync(log);
  const next = { pid: child.pid, url: undefined, log: logPath, startedAt: new Date().toISOString() };
  writeState(next);

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (!alive(child.pid)) fail(`${app} exited while starting. The log ends with:\n${tail()}\nlog: ${logPath}`);
    const url = logUrl();
    if (await answers(url)) {
      writeState({ ...next, url });
      return report({ ...next, url }, "started");
    }
  }
  stop();
  fail(`${app} did not answer within ${START_TIMEOUT_MS / 1000}s. The log ends with:\n${tail()}\nlog: ${logPath}`);
}

if (action === "stop") stop();
else if (action === "start" || action === "restart") {
  lock();
  if (action === "restart") stop();
  await start();
} else fail(`unknown action "${action}": use start, stop or restart`);

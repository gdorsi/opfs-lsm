// Starts the docs site or an example app as a dev server that outlives the shell that started it.
//
//   pnpm dev <app> [start|stop|restart]
//
// <app> is `site` or a folder under examples/. `start` reuses this checkout's server when it still answers, and
// otherwise builds the app's workspace packages, starts the server detached, and prints its URL and log file.
// Each checkout keeps its own servers under .scratch/dev/, so two worktrees never share one.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [app, action = "start"] = process.argv.slice(2);
const START_TIMEOUT_MS = 240_000;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function resolveApp(name) {
  if (name === "site") return { pkg: "@opfs-lsm/site", build: false };
  const manifest = join(root, "examples", name ?? "", "package.json");
  if (!name || !existsSync(manifest)) {
    const examples = spawnSync("ls", [join(root, "examples")], { encoding: "utf8" }).stdout.trim().split("\n");
    fail(`usage: pnpm dev <app> [start|stop|restart]\n<app> is one of: site, ${examples.join(", ")}`);
  }
  return { pkg: JSON.parse(readFileSync(manifest, "utf8")).name, build: true };
}

const { pkg, build } = resolveApp(app);
const dir = join(root, ".scratch", "dev");
const statePath = join(dir, `${app}.json`);
const logPath = join(dir, `${app}.log`);

const readState = () => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : undefined);
const tail = (lines = 15) =>
  existsSync(logPath) ? readFileSync(logPath, "utf8").trimEnd().split("\n").slice(-lines).join("\n") : "";

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function answers(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.status < 500;
  } catch {
    return false;
  }
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
  if (state && alive(state.pid) && (await answers(state.url))) return report(state, "already running");
  if (state && !alive(state.pid)) console.log(`The last ${app} server (pid ${state.pid}) had exited. Its log ended with:\n${tail()}\n`);
  stop();

  mkdirSync(dir, { recursive: true });
  const log = openSync(logPath, "w");
  const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
  if (build) {
    // Examples import the packages' dist, so build what this app depends on first.
    const built = spawnSync("pnpm", ["--filter", `${pkg}^...`, "run", "build"], { cwd: root, stdio: ["ignore", log, log], env });
    if (built.status !== 0) fail(`Building the packages ${app} uses failed. The log ends with:\n${tail()}\nlog: ${logPath}`);
  }
  const child = spawn("pnpm", ["--filter", pkg, "run", "dev"], { cwd: root, detached: true, stdio: ["ignore", log, log], env });
  child.unref();
  closeSync(log);

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (!alive(child.pid)) fail(`${app} exited while starting. The log ends with:\n${tail()}\nlog: ${logPath}`);
    // eslint-disable-next-line no-control-regex
    const url = readFileSync(logPath, "utf8").replace(/\x1b\[[0-9;]*m/g, "").match(/Local:\s+(https?:\/\/\S+)/)?.[1];
    if (url && (await answers(url))) {
      const next = { pid: child.pid, url, log: logPath, startedAt: new Date().toISOString() };
      writeFileSync(statePath, JSON.stringify(next, null, 2) + "\n");
      return report(next, "started");
    }
  }
  stop();
  fail(`${app} did not answer within ${START_TIMEOUT_MS / 1000}s. The log ends with:\n${tail()}\nlog: ${logPath}`);
}

if (action === "start") await start();
else if (action === "stop") stop();
else if (action === "restart") {
  stop();
  await start();
} else fail(`unknown action "${action}": use start, stop or restart`);

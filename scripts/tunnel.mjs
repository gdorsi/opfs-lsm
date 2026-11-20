// Serves the production build of the docs site or an example app at a public HTTPS address, to open it on a phone
// or another machine.
//
//   pnpm tunnel <app>
//
// <app> is `site` or a folder under examples/. kv needs a secure context, so the app does not run from this machine's
// network address over plain HTTP. The address comes from a Cloudflare quick tunnel: anyone who has it can open the
// app until this command stops. It needs `cloudflared` on the PATH.
import { spawn, spawnSync } from "node:child_process";
import { Resolver } from "node:dns/promises";
import { createServer } from "node:net";
import { fail, resolveApp, root } from "./apps.mjs";

const START_TIMEOUT_MS = 60_000;
const name = process.argv[2];
const { pkg, site } = resolveApp(name, "pnpm tunnel <app>");

if (spawnSync("cloudflared", ["--version"]).error) {
  fail("pnpm tunnel needs cloudflared on the PATH. On macOS: brew install cloudflared. Other systems: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/");
}

const built = spawnSync("pnpm", ["--filter", `${pkg}...`, "run", "build"], { cwd: root, stdio: "inherit" });
if (built.status !== 0) fail(`Building ${name} failed.`);

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer().once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const children = [];
/** Starts `command` in its own process group, so stopping it also stops what it started. */
function start(command, args) {
  const child = spawn(command, args, { cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  child.output = "";
  const collect = (chunk) => (child.output += chunk);
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.on("exit", (code) => fail(`${command} exited with code ${code}. Its output ended with:\n${child.output.trimEnd().split("\n").slice(-15).join("\n")}`));
  return child;
}

process.on("exit", () => {
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // It had already exited.
    }
  }
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => process.exit(0));

/** Resolves with the first match of `pattern` in what `child` prints. */
async function printed(child, pattern, what) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-control-regex
    const match = child.output.replace(/\x1b\[[0-9;]*m/g, "").match(pattern);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail(`${what} within ${START_TIMEOUT_MS / 1000}s. Its output ended with:\n${child.output.trimEnd().split("\n").slice(-15).join("\n")}`);
}

const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
const preview = start("pnpm", ["--filter", pkg, "exec", site ? "vitepress" : "vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"]);
// The server prints its own address, which carries the app's base path.
const [, path = "/"] = await printed(preview, new RegExp(`https?://[^\\s/]+:${port}(/\\S*)?`), `${name} did not start`);

// Vite's preview server answers only the hosts it knows, so it gets its own address as the Host header.
const tunnel = start("cloudflared", ["tunnel", "--no-autoupdate", "--url", origin, "--http-host-header", `127.0.0.1:${port}`]);
const [address] = await printed(tunnel, /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/, "cloudflared did not open a tunnel");
await printed(tunnel, /Registered tunnel connection/, "cloudflared did not connect");

// The name takes a few seconds to exist. The system resolver remembers a failed lookup, so this asks a public
// resolver until the name is there, and prints the address only then.
const resolver = new Resolver();
resolver.setServers(["1.1.1.1", "1.0.0.1"]);
const deadline = Date.now() + START_TIMEOUT_MS;
while (!(await resolver.resolve4(new URL(address).hostname).catch(() => undefined))) {
  if (Date.now() > deadline) fail(`${address} did not resolve within ${START_TIMEOUT_MS / 1000}s.`);
  await new Promise((resolve) => setTimeout(resolve, 500));
}

console.log(`\n${name} is at ${address}${path}\nAnyone who has this address can open it. Press Ctrl+C to stop.`);

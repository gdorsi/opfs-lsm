/**
 * Crash one tab with Page.crash and print the CDP events Chrome on Android
 * sends: a foreground tab crashed right after it opens, a foreground tab
 * crashed 1.5 s later, and a background tab. Twice each. Then ask the browser
 * to close.
 *
 *   ANDROID_SERIAL=<serial> node docs/research/android-device-run/crash-events.mjs
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const shim = path.join(path.dirname(fileURLToPath(import.meta.url)), "android-chrome.mjs");

async function run(where, waitMs) {
  const profile = mkdtempSync(path.join(tmpdir(), "crash-events-"));
  const child = spawn(shim, [`--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], { detached: true, stdio: "ignore" });
  const portFile = path.join(profile, "DevToolsActivePort");
  while (!existsSync(portFile)) await sleep(100);
  const port = readFileSync(portFile, "utf8").split("\n")[0];

  const ws = new WebSocket(`ws://127.0.0.1:${port}/devtools/browser`);
  await new Promise((resolve) => (ws.onopen = resolve));
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id !== undefined) pending.get(m.id)?.(m);
    else events.push(`${m.method}${m.sessionId ? " (page session)" : ""} ${JSON.stringify(m.params)}`);
  };
  const send = (method, params = {}, sessionId, timeoutMs = 5000) =>
    Promise.race([
      new Promise((resolve) => {
        const n = ++id;
        pending.set(n, (m) => resolve(m.error ? `error: ${m.error.message}` : m.result));
        ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
      }),
      sleep(timeoutMs).then(() => `no reply in ${timeoutMs} ms`),
    ]);

  await send("Target.setDiscoverTargets", { discover: true });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Runtime.enable", {}, sessionId);
  // On a phone the newest tab is the only visible one, so a second tab puts the first in the background.
  if (where === "background") await send("Target.createTarget", { url: "about:blank" });
  await sleep(waitMs);
  const visibility = await send("Runtime.evaluate", { expression: "document.visibilityState", returnByValue: true }, sessionId);
  console.log(`\n${where} tab, crashed ${waitMs} ms after it opened, visibilityState ${visibility.result?.value}`);
  events.length = 0;
  console.log(`  Page.crash reply: ${JSON.stringify(await send("Page.crash", {}, sessionId, 4000))}`);
  await sleep(6000);
  console.log("  events in the 6 s after Page.crash:");
  for (const e of events) console.log(`    ${e}`);
  console.log(`  evaluate after the crash: ${JSON.stringify(await send("Runtime.evaluate", { expression: "1+1", returnByValue: true }, sessionId, 4000))}`);
  const targets = await send("Target.getTargets");
  console.log(`  target still listed: ${targets.targetInfos ? targets.targetInfos.some((t) => t.targetId === targetId) : JSON.stringify(targets)}`);
  console.log(`  Browser.close reply: ${JSON.stringify(await send("Browser.close", {}, undefined, 4000))}`);
  console.log(`  browser process ${child.exitCode === null ? "still running" : "gone"}`);
  ws.close();
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {}
  rmSync(profile, { recursive: true, force: true });
}

for (const [where, waitMs] of [["foreground", 0], ["foreground", 1500], ["background", 1500]]) {
  for (let rep = 0; rep < 2; rep++) await run(where, waitMs);
}
process.exit(0);

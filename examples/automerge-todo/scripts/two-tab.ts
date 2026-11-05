/**
 * Evidence run against a running `pnpm automerge:example` server.
 *
 *   AUTOMERGE_NO_OPEN=1 pnpm automerge:example
 *   pnpm --filter @opfs-lsm/example-automerge exec tsx scripts/two-tab.ts
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const port = Number(process.env.AUTOMERGE_PORT ?? 4174);
const name = `am${Date.now()}`;
const pageUrl = `http://127.0.0.1:${port}/?name=${name}`;

type Target = {
  id: string;
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
};

type Step = { name: string; ok: boolean; detail: string };

function chromePath(): string {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (fs.existsSync(mac)) return mac;
  return "google-chrome";
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("expected TCP listen address"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function chromeArgs(profile: string, debugPort: number, url: string): string[] {
  return [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--enable-features=FileSystemAccessAPI",
    "--remote-allow-origins=*",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${debugPort}`,
    url,
  ];
}

function killChrome(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

async function listTargets(debugPort: number): Promise<Target[]> {
  const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
  if (!res.ok) throw new Error(`json/list ${res.status}`);
  return (await res.json()) as Target[];
}

function pagesNamed(list: Target[]): Target[] {
  return list.filter(
    (target) =>
      target.type === "page" &&
      (target.url ?? "").includes(name) &&
      target.webSocketDebuggerUrl,
  );
}

async function waitForPage(debugPort: number, exclude: string | undefined): Promise<Target> {
  const deadline = Date.now() + 20_000;
  let last = "page missing";
  while (Date.now() < deadline) {
    try {
      const page = pagesNamed(await listTargets(debugPort)).find(
        (target) => target.id !== exclude,
      );
      if (page) return page;
      last = "page not listed";
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await sleep(50);
  }
  throw new Error(last);
}

async function socketFor(debugPort: number, id: string): Promise<string> {
  const deadline = Date.now() + 20_000;
  let last = `target ${id} missing`;
  while (Date.now() < deadline) {
    try {
      const page = (await listTargets(debugPort)).find((target) => target.id === id);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      last = `target ${id} has no socket`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await sleep(50);
  }
  throw new Error(last);
}

function devtoolsCall(
  wsUrl: string,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`${method} timeout`));
    }, 20_000);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number;
        error?: { message?: string };
        result?: {
          exceptionDetails?: { text?: string; exception?: { description?: string } };
          result?: { value?: unknown };
        };
      };
      if (msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (msg.error) {
        reject(new Error(msg.error.message ?? `${method} failed`));
        return;
      }
      const details = msg.result?.exceptionDetails;
      if (details) {
        reject(
          new Error(details.exception?.description ?? details.text ?? `${method} threw`),
        );
        return;
      }
      resolve(msg.result?.result?.value);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("devtools socket error"));
    });
  });
}

function evaluate(wsUrl: string, expression: string): Promise<unknown> {
  return devtoolsCall(wsUrl, "Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
}

async function browserSocket(debugPort: number): Promise<string> {
  const deadline = Date.now() + 10_000;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      if (res.ok) {
        const body = (await res.json()) as { webSocketDebuggerUrl?: string };
        if (body.webSocketDebuggerUrl) return body.webSocketDebuggerUrl;
        last = "missing webSocketDebuggerUrl";
      } else {
        last = `status ${res.status}`;
      }
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await sleep(50);
  }
  throw new Error(`devtools not ready: ${last}`);
}

async function openWindow(debugPort: number, url: string): Promise<void> {
  const wsUrl = await browserSocket(debugPort);
  await devtoolsCall(wsUrl, "Target.createTarget", { url, newWindow: true });
}

async function waitForValue(
  debugPort: number,
  id: string,
  expression: string,
  ms: number,
): Promise<unknown> {
  const deadline = Date.now() + ms;
  let last: unknown = "not ready";
  for (;;) {
    try {
      const value = await evaluate(await socketFor(debugPort, id), expression);
      if (value) return value;
      last = value;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() >= deadline) break;
    await sleep(100);
  }
  throw new Error(typeof last === "string" ? last : JSON.stringify(last));
}

const READY = `Boolean(document.querySelector('input[placeholder="Add a new todo"]'))`;

const TODOS = `[...document.querySelectorAll("li input:not([type=checkbox])")].map((el) => el.value)`;

function createTodo(text: string): string {
  return `(() => {
    const input = document.querySelector('input[placeholder="Add a new todo"]');
    if (!input || !input.form) return false;
    input.value = ${JSON.stringify(text)};
    input.form.requestSubmit();
    return true;
  })()`;
}

function editTodo(text: string): string {
  return `(async () => {
    const field = document.querySelector("li input:not([type=checkbox])");
    if (!field) return { ok: false, compacted: false, value: null };
    if (!window.__compactHook) {
      window.__compacted = 0;
      window.repo.on("doc-metrics", (event) => {
        if (event.type === "doc-compacted") window.__compacted += 1;
      });
      window.__compactHook = true;
    }
    const before = window.__compacted;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    set.call(field, ${JSON.stringify(text)});
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    await window.repo.flush();
    return {
      ok: true,
      compacted: window.__compacted > before,
      value: field.value,
    };
  })()`;
}

function report(step: Step): void {
  console.log(`${step.ok ? "PASS" : "FAIL"} ${step.name}: ${step.detail}`);
}

async function main(): Promise<number> {
  const steps: Step[] = [];
  const debugPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "automerge-two-tab-"));
  const chrome = spawn(chromePath(), chromeArgs(profile, debugPort, pageUrl), {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  chrome.unref();

  try {
    console.log(`url ${pageUrl}`);
    const windowA = await waitForPage(debugPort, undefined);
    await waitForValue(debugPort, windowA.id, READY, 20_000);
    const created = await evaluate(
      await socketFor(debugPort, windowA.id),
      createTodo("buy milk"),
    );
    if (created !== true) throw new Error("create todo did not submit");

    const openedAt = Date.now();
    await openWindow(debugPort, pageUrl);
    const windowB = await waitForPage(debugPort, windowA.id);
    const live = (await waitForValue(
      debugPort,
      windowB.id,
      `(() => { const todos = ${TODOS}; return todos.includes("buy milk") ? todos : null; })()`,
      Math.max(0, 2_000 - (Date.now() - openedAt)),
    )) as string[];
    steps.push({
      name: "live",
      ok: live.includes("buy milk"),
      detail: `B saw ${JSON.stringify(live)} within 2s`,
    });

    const edited = (await evaluate(
      await socketFor(debugPort, windowA.id),
      editTodo("buy oat milk"),
    )) as { ok: boolean; value: string | null };
    const afterEdit = (await waitForValue(
      debugPort,
      windowB.id,
      `(() => { const todos = ${TODOS}; return todos.includes("buy oat milk") ? todos : null; })()`,
      5_000,
    )) as string[];
    steps.push({
      name: "edit",
      ok: edited.ok === true && afterEdit.includes("buy oat milk"),
      detail: `B saw ${JSON.stringify(afterEdit)}`,
    });

    await evaluate(await socketFor(debugPort, windowB.id), "location.reload()");
    const restored = (await waitForValue(
      debugPort,
      windowB.id,
      `(() => { const todos = ${TODOS}; return todos.includes("buy oat milk") ? todos : null; })()`,
      20_000,
    )) as string[];
    steps.push({
      name: "reload",
      ok: restored.includes("buy oat milk"),
      detail: `B restored ${JSON.stringify(restored)} from storage`,
    });

    const compacted = (await evaluate(
      await socketFor(debugPort, windowA.id),
      editTodo("buy oat milk now"),
    )) as { compacted: boolean; value: string | null };
    await evaluate(await socketFor(debugPort, windowB.id), "location.reload()");
    const afterCompact = (await waitForValue(
      debugPort,
      windowB.id,
      `(() => { const todos = ${TODOS}; return todos.includes("buy oat milk now") ? todos : null; })()`,
      20_000,
    )) as string[];
    const matched = afterCompact.includes("buy oat milk now");
    steps.push({
      name: "compaction-reload",
      ok: compacted.compacted === true && matched,
      detail: `compacted=${compacted.compacted} B=${JSON.stringify(afterCompact)} A=${JSON.stringify(compacted.value)}`,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const pending = ["live", "edit", "reload", "compaction-reload"].filter(
      (name) => !steps.some((step) => step.name === name),
    );
    for (const name of pending) steps.push({ name, ok: false, detail });
  } finally {
    for (const step of steps) report(step);
    killChrome(chrome);
    fs.rmSync(profile, { recursive: true, force: true });
  }
  return steps.every((step) => step.ok) ? 0 : 1;
}

process.exitCode = await main();

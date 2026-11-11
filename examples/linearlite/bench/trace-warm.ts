import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const [origin = "http://127.0.0.1:4200", out = "warm-trace.json", profileArg] = process.argv.slice(2);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  private id = 0;
  private pending = new Map<number, (v: any) => void>();
  readonly events: any[] = [];
  private ws: WebSocket;
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.id !== undefined) {
        if (msg.error) throw new Error(JSON.stringify(msg.error));
        this.pending.get(msg.id)?.(msg.result);
      } else this.events.push(msg);
    };
  }
  static async open(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
    return new Cdp(ws);
  }
  send(method: string, params: object = {}): Promise<any> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((r) => this.pending.set(id, r));
  }
  close() {
    this.ws.close();
  }
}

async function launch(profile: string, port: number) {
  const proc = spawn(CHROME, ["--headless=new", "--disable-gpu", `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "about:blank"], { stdio: "ignore" });
  await sleep(1500);
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const pages = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as any[];
  const browser = await Cdp.open(version.webSocketDebuggerUrl);
  const page = await Cdp.open(pages.find((p) => p.type === "page").webSocketDebuggerUrl);
  return { proc, browser, page };
}

async function evalPage(page: Cdp, expr: string): Promise<any> {
  const r = await page.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result.value;
}

const marks = `Object.fromEntries(performance.getEntriesByType("mark").map((m) => [m.name.replace("linearlite:", ""), Math.round(m.startTime)]))`;

async function waitMark(page: Cdp, name: string, timeoutMs = 300_000): Promise<Record<string, number>> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const m = await evalPage(page, marks).catch(() => ({}));
    if (m && m[name] !== undefined) return m;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${name}`);
}

async function quit(c: Awaited<ReturnType<typeof launch>>) {
  c.page.close();
  c.browser.close();
  c.proc.kill();
  await new Promise((r) => c.proc.once("exit", r));
}

const profile = profileArg ?? mkdtempSync(join(tmpdir(), "linearlite-trace-"));
if (!profileArg) {
  const c = await launch(profile, Number(process.env.CDP_PORT ?? 9500));
  await c.page.send("Page.navigate", { url: `${origin}/issues` });
  const m = await waitMark(c.page, "caught-up:comments");
  console.error("filled", m);
  await sleep(2000);
  await quit(c);
}

const c = await launch(profile, Number(process.env.CDP_PORT ?? 9500) + 1);
await c.browser.send("Tracing.start", {
  transferMode: "ReportEvents",
  traceConfig: {
    recordMode: "recordAsMuchAsPossible",
    includedCategories: [
      "devtools.timeline",
      "disabled-by-default-devtools.timeline",
      "disabled-by-default-devtools.timeline.frame",
      "v8.execute",
      "v8",
      "disabled-by-default-v8.cpu_profiler",
      "blink.user_timing",
      "loading",
      "toplevel",
      "disabled-by-default-v8.gc",
    ],
  },
});
await c.page.send("Page.navigate", { url: `${origin}/issues` });
const m = await waitMark(c.page, "first-rows");
await sleep(1000);
const rows = await evalPage(c.page, `document.querySelectorAll(".row[data-id]").length`);
await c.browser.send("Tracing.end");
const end = Date.now() + 60_000;
while (!c.browser.events.some((e) => e.method === "Tracing.tracingComplete") && Date.now() < end) await sleep(200);
const traceEvents = c.browser.events.filter((e) => e.method === "Tracing.dataCollected").flatMap((e) => e.params.value);
writeFileSync(out, JSON.stringify({ traceEvents }));
console.log(JSON.stringify({ marks: m, rows, events: traceEvents.length, profile, out }));
await quit(c);

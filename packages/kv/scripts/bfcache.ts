/**
 * Chrome proof: a page with an open Db can enter the back/forward cache,
 * and another tab's `sync` finishes while it is there.
 *
 *   pnpm --filter @opfs-lsm/kv bfcache
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
};

function chromePath(): string {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return fs.existsSync(mac) ? mac : "google-chrome";
}

function serve(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]!);
    const file = path.join(root, path.normalize(urlPath));
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end();
        return;
      }
      // no-store keeps a page out of the back/forward cache, so pages get a short max-age.
      const html = path.extname(file) === ".html";
      res.writeHead(200, {
        "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
        "cache-control": html ? "max-age=0" : "no-store",
      });
      res.end(data);
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port })),
  );
}

async function debuggerUrl(port: number): Promise<string> {
  for (let i = 0; i < 200; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      const body = (await res.json()) as { webSocketDebuggerUrl?: string };
      if (body.webSocketDebuggerUrl) return body.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(50);
  }
  throw new Error("devtools did not come up");
}

type Event = { method: string; params: Record<string, unknown>; sessionId?: string };

class Cdp {
  private nextId = 1;
  private readonly calls = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  readonly events: Event[] = [];

  private readonly ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
      } & Event;
      if (msg.id === undefined) {
        this.events.push(msg);
        return;
      }
      const call = this.calls.get(msg.id);
      this.calls.delete(msg.id);
      if (msg.error) call?.reject(new Error(msg.error.message));
      else call?.resolve(msg.result);
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve);
      ws.addEventListener("error", reject);
    });
    return new Cdp(ws);
  }

  send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  async page(url: string): Promise<Page> {
    const { targetId } = await this.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await this.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    await this.send("Page.enable", {}, sessionId);
    const page = new Page(this, sessionId);
    await page.goto(url);
    return page;
  }

  close(): void {
    this.ws.close();
  }
}

class Page {
  private readonly cdp: Cdp;
  readonly sessionId: string;

  constructor(cdp: Cdp, sessionId: string) {
    this.cdp = cdp;
    this.sessionId = sessionId;
  }

  async eval<T>(expression: string, timeoutMs = 10_000): Promise<T> {
    const out = await this.cdp.send<{
      result: { value?: T };
      exceptionDetails?: { exception?: { description?: string }; text: string };
    }>(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs },
      this.sessionId,
    );
    if (out.exceptionDetails) {
      throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text);
    }
    return out.result.value as T;
  }

  async until(expression: string, what: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (await this.eval<boolean>(expression)) return;
      } catch {
        /* navigating */
      }
      await sleep(50);
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  async goto(url: string): Promise<void> {
    await this.cdp.send("Page.navigate", { url }, this.sessionId);
  }

  async back(): Promise<void> {
    const { currentIndex, entries } = await this.cdp.send<{ currentIndex: number; entries: { id: number }[] }>(
      "Page.getNavigationHistory",
      {},
      this.sessionId,
    );
    await this.cdp.send("Page.navigateToHistoryEntry", { entryId: entries[currentIndex - 1]!.id }, this.sessionId);
  }

  /** Why the last navigation away could not use the back/forward cache, if it could not. */
  notCached(): unknown[] {
    return this.cdp.events
      .filter((e) => e.method === "Page.backForwardCacheNotUsed" && e.sessionId === this.sessionId)
      .map((e) => e.params.notRestoredExplanations);
  }
}

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    sleep(ms).then(() => {
      throw new Error(`${what} did not finish in ${ms} ms`);
    }),
  ]);
}

async function main(): Promise<number> {
  if (!fs.existsSync(path.join(root, "dist/index.js"))) {
    console.error("missing dist. Run pnpm --filter @opfs-lsm/kv build");
    return 1;
  }
  const { server, port } = await serve();
  const debugPort = 9300 + Math.floor(Math.random() * 500);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "opfs-bfcache-"));
  const chrome = spawn(
    chromePath(),
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--remote-allow-origins=*",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${debugPort}`,
      "about:blank",
    ],
    { stdio: "ignore", detached: true },
  );
  let cdp: Cdp | undefined;
  try {
    cdp = await Cdp.connect(await debuggerUrl(debugPort));
    const page = `http://127.0.0.1:${port}/proof/bfcache.html`;
    const a = await cdp.page(page);
    await a.until(`document.getElementById("status")?.textContent === "ready"`, "tab A to open");
    const b = await cdp.page(page);
    await b.until(`document.getElementById("status")?.textContent === "ready"`, "tab B to open");

    await a.eval(`kv.put("a1", "1")`);
    await within(b.eval(`kv.sync()`), 5_000, "B's sync before A leaves");
    if ((await b.eval(`kv.get("a1")`)) !== "1") throw new Error("B does not see A's write");

    await a.eval(`window.cachedMarker = 1`);
    await a.goto(`http://127.0.0.1:${port}/proof/away.html`);
    await a.until(`location.pathname === "/proof/away.html" && document.readyState === "complete"`, "A to leave");
    await sleep(200);

    await b.eval(`kv.put("b1", "1")`);
    const t0 = performance.now();
    await within(b.eval(`kv.sync()`), 5_000, "B's sync while A is cached");
    console.log(`B sync while A away: ${(performance.now() - t0).toFixed(0)} ms`);
    await within(b.eval(`kv.ingest()`), 10_000, "B's ingest while A is cached");

    await a.back();
    await a.until(`location.pathname === "/proof/bfcache.html" && document.readyState === "complete"`, "A to come back");
    const restored = await a.eval<boolean>(`window.cachedMarker === 1`);
    const notCached = a.notCached();
    console.log(`A restored from the back/forward cache: ${restored}`);
    if (!restored) console.log(`not cached because: ${JSON.stringify(notCached)}`);

    await a.until(`typeof kv === "object"`, "A's Db after coming back");
    await within(a.eval(`kv.sync()`), 5_000, "A's sync after coming back");
    if ((await a.eval(`kv.get("b1")`)) !== "1") throw new Error("A does not see B's write after coming back");
    await a.eval(`kv.put("a2", "2")`);
    await within(b.eval(`kv.sync()`), 5_000, "B's sync after A came back");
    if ((await b.eval(`kv.get("a2")`)) !== "2") throw new Error("B does not see A's write after A came back");
    if ((await b.eval(`kv.get("a1")`)) !== "1") throw new Error("B lost A's write from before it left");
    if (!restored) {
      console.error("bfcache: A was not restored from the back/forward cache");
      return 1;
    }
    console.log(`A's pageshow persisted: ${JSON.stringify(await a.eval(`kv.shows`))}`);
    console.log("bfcache ok");
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return 1;
  } finally {
    cdp?.close();
    try {
      process.kill(-chrome.pid!, "SIGKILL");
    } catch {
      chrome.kill("SIGKILL");
    }
    server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

process.exit(await main());

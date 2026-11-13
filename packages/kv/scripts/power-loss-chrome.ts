/**
 * Put real Chrome's IndexedDB back to an older copy while OPFS keeps its
 * newer files, relaunch, and check that the database opens to a log prefix
 * and that a write acked after recovery is read back.
 *
 *   pnpm --filter @opfs-lsm/kv power-loss-chrome [--verbose]
 *
 * This is the state a power loss leaves when OPFS reached the disk and the
 * newest IndexedDB commits did not (design.md, "Recovery"). `kill-chrome`
 * cannot reach it: a process kill keeps whatever reached the OS. Here the
 * loss is made by hand. While Chrome runs, the IndexedDB directory of the
 * profile is copied. After Chrome quits, the copy replaces the directory.
 * The key generator of `wal` lives in that directory, so it goes back with
 * the records, which fake-indexeddb can only model.
 *
 * It is not a power cut: the copy is whole, and OPFS loses nothing. The
 * crash simulator and `formal:power-loss` cover every pair of prefixes.
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verbose = process.argv.includes("--verbose");
const DB = "power-loss";

/** The page: kv from `dist`, plus a raw read of the WAL database that never creates it. */
const PAGE = `<!doctype html><script type="module">
import { openDb } from "/src/index.js";
import { settle } from "/src/testing.js";
const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => (b ? new TextDecoder().decode(b) : null);
const req = (r) => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
let db;
window.kv = {
  async open() { db = await openDb({ name: ${JSON.stringify(DB)} }); },
  async put(from, to) { for (let i = from; i <= to; i++) await db.put(enc("k" + i), enc("v" + i)); },
  async get(from, to) { const out = []; for (let i = from; i <= to; i++) out.push(dec(await db.get(enc("k" + i)))); return out; },
  async flush() { await settle(db); },
  async raw() {
    const name = "opfs-lsm-wal/" + ${JSON.stringify(DB)};
    if (!(await indexedDB.databases()).some((d) => d.name === name)) return null;
    const idb = await req(indexedDB.open(name));
    try {
      const tx = idb.transaction(["wal", "meta"]);
      return {
        keys: await req(tx.objectStore("wal").getAllKeys()),
        ingestedThrough: (await req(tx.objectStore("meta").get("ingestedThrough"))) ?? 0,
      };
    } finally {
      idb.close();
    }
  },
};
window.ready = true;
</script>`;

const MIME: Record<string, string> = { ".js": "text/javascript; charset=utf-8", ".wasm": "application/wasm" };

async function startServer(): Promise<{ server: http.Server; origin: string }> {
  const server = http.createServer((q, res) => {
    const url = (q.url ?? "/").split("?")[0] ?? "/";
    if (url === "/") {
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }).end(PAGE);
      return;
    }
    const clean = path.posix.normalize(decodeURIComponent(url));
    const file = clean.startsWith("/src/") ? path.join(root, "dist", clean.slice(5)) : clean.startsWith("/wasm/") ? path.join(root, clean) : "";
    if (!file || clean.includes("..") || !fs.existsSync(file)) {
      res.writeHead(404).end(`missing ${url}`);
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(fs.readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("expected a TCP address");
  // Storage is per origin, so every launch of a scenario uses this one server.
  return { server, origin: `http://127.0.0.1:${addr.port}` };
}

function chromePath(): string {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return fs.existsSync(mac) ? mac : "google-chrome";
}

type Raw = { keys: number[]; ingestedThrough: number } | null;

/** One Chrome on `profile` with one tab on the page. */
class Session {
  private constructor(
    private readonly send: (method: string, params?: object, sessionId?: string) => Promise<Record<string, unknown>>,
    private readonly sessionId: string,
    private readonly exited: Promise<void>,
    private readonly kill: () => void,
  ) {}

  static async launch(profile: string, origin: string): Promise<Session> {
    const args = [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-breakpad",
      "--disable-crash-reporter",
      "--remote-allow-origins=*",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ];
    if (process.env.CI === "true") args.push("--no-sandbox", "--disable-dev-shm-usage");
    const portFile = path.join(profile, "DevToolsActivePort");
    fs.rmSync(portFile, { force: true });
    const child = spawn(chromePath(), args, { stdio: "ignore", detached: true });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const kill = () => {
      if (child.exitCode === null && child.pid) process.kill(-child.pid, "SIGKILL");
    };
    try {
      let wsUrl = "";
      for (const deadline = Date.now() + 20_000; !wsUrl; await sleep(50)) {
        if (child.exitCode !== null) throw new Error(`chrome exited with ${child.exitCode} before devtools was ready`);
        if (Date.now() > deadline) throw new Error("devtools not ready after 20s");
        try {
          const [port, wsPath] = fs.readFileSync(portFile, "utf8").split("\n");
          if (port && wsPath) wsUrl = `ws://127.0.0.1:${port}${wsPath}`;
        } catch {
          /* not written yet */
        }
      }
      const ws = new WebSocket(wsUrl);
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("devtools socket failed"));
      });
      let id = 0;
      type Reply = { result?: Record<string, unknown>; error?: unknown };
      const waiting = new Map<number, (m: Reply) => void>();
      ws.onmessage = (e) => {
        const m = JSON.parse(String(e.data)) as Reply & { id?: number };
        if (m.id === undefined) return;
        waiting.get(m.id)?.(m);
        waiting.delete(m.id);
      };
      // Chrome died or quit: fail the calls still waiting, so nothing hangs.
      ws.onclose = () => {
        for (const settle of waiting.values()) settle({ error: "devtools socket closed" });
        waiting.clear();
      };
      const send = (method: string, params: object = {}, sessionId?: string) =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          if (ws.readyState !== WebSocket.OPEN) return reject(new Error(`${method}: devtools socket closed`));
          const n = ++id;
          waiting.set(n, (m) => (m.error ? reject(new Error(`${method}: ${JSON.stringify(m.error)}`)) : resolve(m.result ?? {})));
          ws.send(JSON.stringify({ id: n, method, params, sessionId }));
        });
      const { targetId } = await send("Target.createTarget", { url: `${origin}/` });
      const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
      const session = new Session(send, sessionId as string, exited, kill);
      for (const deadline = Date.now() + 20_000; (await session.evaluate("window.ready === true")) !== true; await sleep(50)) {
        if (Date.now() > deadline) throw new Error("the page did not load kv");
      }
      return session;
    } catch (err) {
      // No session was handed out, so nobody else can stop this Chrome.
      kill();
      await exited;
      throw err;
    }
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const r = (await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, this.sessionId)) as {
      result?: { value?: unknown };
      exceptionDetails?: { exception?: { description?: string }; text?: string };
    };
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "evaluate failed");
    return r.result?.value as T;
  }

  /** A clean quit: everything Chrome wrote is in its files. */
  async quit(): Promise<void> {
    await this.send("Browser.close").catch(() => undefined);
    await Promise.race([this.exited, sleep(10_000)]);
    this.kill();
    await this.exited;
  }
}

class Failed extends Error {}

function check(ok: boolean, what: string): void {
  if (!ok) throw new Failed(what);
}

/** One profile, relaunched as often as the scenario asks. */
class Run {
  private session: Session | undefined;
  private readonly idbDir: string;
  private readonly copy: string;
  /** Keys put so far: k1..kWritten. */
  written = 0;

  constructor(
    private readonly profile: string,
    private readonly origin: string,
    private readonly note: (line: string) => void,
  ) {
    this.idbDir = path.join(profile, "Default", "IndexedDB");
    this.copy = path.join(profile, "indexeddb-copy");
  }

  private get tab(): Session {
    if (!this.session) throw new Error("no browser");
    return this.session;
  }

  async launch(): Promise<void> {
    this.session = await Session.launch(this.profile, this.origin);
  }

  async quit(): Promise<void> {
    await this.session?.quit();
    this.session = undefined;
  }

  async open(): Promise<void> {
    await this.tab.evaluate("kv.open()");
  }

  async put(count: number): Promise<void> {
    await this.tab.evaluate(`kv.put(${this.written + 1}, ${this.written + count})`);
    this.written += count;
  }

  async flush(): Promise<void> {
    await this.tab.evaluate("kv.flush()");
  }

  async raw(): Promise<Raw> {
    return this.tab.evaluate<Raw>("kv.raw()");
  }

  /** Copy the IndexedDB directory as it is on disk now. Copies again when the WAL moved under the copy. */
  async copyIdb(): Promise<Raw> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const before = await this.raw();
      fs.rmSync(this.copy, { recursive: true, force: true });
      fs.cpSync(this.idbDir, this.copy, { recursive: true });
      if (JSON.stringify(await this.raw()) === JSON.stringify(before)) return before;
    }
    throw new Failed("the WAL kept changing while its directory was copied");
  }

  /**
   * Quit, put IndexedDB back to the copy, relaunch. Checks that the copy is
   * what Chrome reads: without that the scenario tests nothing.
   */
  async loseIdbSince(copied: Raw): Promise<void> {
    await this.quit();
    fs.rmSync(this.idbDir, { recursive: true, force: true });
    fs.cpSync(this.copy, this.idbDir, { recursive: true });
    await this.launch();
    const now = await this.raw();
    this.note(`  IndexedDB back to ${JSON.stringify(now)}`);
    check(JSON.stringify(now) === JSON.stringify(copied), `the relaunch did not read the copy: copied ${JSON.stringify(copied)}, read ${JSON.stringify(now)}`);
  }

  /** How many of k1..kWritten read back, when those are a prefix. */
  async readPrefix(): Promise<number> {
    const got = await this.tab.evaluate<(string | null)[]>(`kv.get(1, ${this.written})`);
    const kept = got.findIndex((v) => v === null);
    const n = kept === -1 ? got.length : kept;
    for (const [i, v] of got.entries()) {
      check(i < n ? v === `v${i + 1}` : v === null, `the read is not a prefix of the writes: k${i + 1} is ${JSON.stringify(v)} with ${n} kept`);
    }
    return n;
  }

  /**
   * After a loss: open, read at least `atLeast` writes as a prefix, put one
   * more key, and check that it took a seq past every seq in use and that
   * it is read back, here and after a clean restart.
   */
  async recoverAndWrite(atLeast: number): Promise<void> {
    await this.open();
    const kept = await this.readPrefix();
    check(kept >= atLeast, `OPFS held ${atLeast} writes and the open reads ${kept}`);
    // Writes the loss dropped are gone for good: number on from what was kept.
    this.written = kept;
    const before = await this.raw();
    check(before !== null, "no WAL database after the open");
    await this.put(1);
    const after = await this.raw();
    const added = after!.keys.filter((k) => !before!.keys.includes(k));
    this.note(`  kept ${kept}, WAL before the put ${JSON.stringify(before)}, after ${JSON.stringify(after)}`);
    check(added.length === 1, `the put added ${added.length} WAL records`);
    const used = Math.max(before!.ingestedThrough, ...before!.keys);
    check(added[0]! > used, `the put took seq ${added[0]}, at or below ${used}, a seq already in use`);
    check((await this.readPrefix()) === this.written, "the put is not read back in the tab that wrote it");
    await this.quit();
    await this.launch();
    await this.open();
    check((await this.readPrefix()) === this.written, "the put is not read back after a restart");
  }
}

type Scenario = { name: string; run(r: Run): Promise<void> };

const scenarios: Scenario[] = [
  {
    name: "IndexedDB loses its newest records, OPFS keeps the flush that holds them",
    async run(r) {
      await r.put(7);
      const copied = await r.copyIdb();
      await r.put(13);
      await r.flush();
      await r.loseIdbSince(copied);
      await r.recoverAndWrite(20);
    },
  },
  {
    name: "IndexedDB loses every record, OPFS keeps the flush",
    async run(r) {
      const copied = await r.copyIdb();
      await r.put(20);
      await r.flush();
      await r.loseIdbSince(copied);
      await r.recoverAndWrite(20);
    },
  },
  {
    name: "IndexedDB loses the commit of a second flush, OPFS keeps its files",
    async run(r) {
      await r.put(7);
      await r.flush();
      const copied = await r.copyIdb();
      await r.put(13);
      await r.flush();
      await r.loseIdbSince(copied);
      await r.recoverAndWrite(20);
    },
  },
  {
    name: "a second loss undoes the recovery and the write after it",
    async run(r) {
      await r.put(7);
      const copied = await r.copyIdb();
      await r.put(13);
      await r.flush();
      await r.loseIdbSince(copied);
      await r.recoverAndWrite(20);
      await r.loseIdbSince(copied);
      await r.recoverAndWrite(20);
    },
  },
  {
    name: "a second loss undoes the recovery, OPFS keeps the write after it",
    async run(r) {
      await r.put(7);
      const copied = await r.copyIdb();
      await r.put(13);
      await r.flush();
      await r.loseIdbSince(copied);
      await r.recoverAndWrite(20);
      await r.flush();
      await r.loseIdbSince(copied);
      await r.recoverAndWrite(21);
    },
  },
];

async function main(): Promise<number> {
  const { server, origin } = await startServer();
  let failures = 0;
  try {
    for (const scenario of scenarios) {
      const profile = fs.mkdtempSync(path.join(os.tmpdir(), "opfs-power-loss-chrome-"));
      const notes: string[] = [];
      const run = new Run(profile, origin, (line) => notes.push(line));
      try {
        await run.launch();
        await run.open();
        await scenario.run(run);
        console.log(`ok    ${scenario.name}`);
        if (verbose) for (const n of notes) console.log(n);
      } catch (err) {
        failures += 1;
        console.log(`FAIL  ${scenario.name}`);
        for (const n of notes) console.log(n);
        console.log(`  ${err instanceof Failed ? err.message : String((err as Error).stack ?? err)}`);
      } finally {
        await run.quit().catch(() => undefined);
        fs.rmSync(profile, { recursive: true, force: true });
      }
    }
  } finally {
    server.close();
  }
  console.log(failures === 0 ? `power-loss-chrome ok (${scenarios.length} scenarios)` : `power-loss-chrome FAILED (${failures} of ${scenarios.length})`);
  return failures === 0 ? 0 : 1;
}

process.exit(await main());

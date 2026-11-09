/**
 * Does Chrome forget OPFS files created in the session after a browser
 * crash? No engine involved: a page and dedicated WebWorkers churn OPFS
 * files, the browser dies, and the next sessions check what survived.
 *
 *   node packages/kv/scripts/opfs-loss-repro.ts [--iterations N] [--mode M] [--kill sigkill|crash|group] [--keep]
 *
 * Each iteration, on one profile:
 *   A  churn: 2 dedicated WebWorkers create, write, flush, close and remove
 *      small files through SyncAccessHandle, the page rewrites files with
 *      createWritable; the browser is killed at a random time (`sigkill` of
 *      the browser process, CDP `Browser.crash`, or `group`: every process).
 *   B  relaunch: create K marker files, remove some churn files, close
 *      Chrome gracefully (Browser.close).
 *   C  relaunch: list the markers. A missing marker is a lost file.
 * Between sessions the `Paths` LevelDB log of the origin's file system is
 * read with leveldb-log.ts to find torn and corrupt records.
 *
 * The kill can tear the tail of the `Paths` log (a record header written
 * without its payload). Chrome reopens that log and appends after the torn
 * bytes, and LevelDB's reader drops the rest of the 32 KiB block at the
 * next open: whatever session B wrote there is forgotten.
 *
 * Modes, the knobs an engine controls:
 *   none    as above
 *   reuse   session A only rewrites a fixed set of files through SyncAccessHandle, no metadata ops
 *   idle    an extra session between A and B that opens the page and does nothing
 *   tiny    session B writes one file, then waits 1 s, before the markers
 *   wait    session B waits --wait-ms before the markers
 *   pad     session B creates and removes --pad throwaway files before the markers
 *   engine  sessions A and B first open a database directory through the engine's
 *           padded OPFS root (dist/opfs/root.js; build kv first)
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { physicalRecords } from "./leveldb-log.ts";

const MODES = ["none", "reuse", "idle", "tiny", "wait", "pad", "engine"] as const;
type Mode = (typeof MODES)[number];

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : fallback;
}
const iterations = Number(arg("iterations", "20"));
const mode = arg("mode", "none") as Mode;
if (!MODES.includes(mode)) throw new Error(`unknown mode ${mode}`);
const kill = arg("kill", "sigkill");
const markers = Number(arg("markers", "20"));
const pad = Number(arg("pad", "200"));
const waitMs = Number(arg("wait-ms", "5000"));
const rotate = Number(arg("rotate", "1"));
const keep = process.argv.includes("--keep");

const PAGE = `<!doctype html><meta charset=utf-8><script type=module>
const root = () => navigator.storage.getDirectory();
const dir = async (name) => (await root()).getDirectoryHandle(name, { create: true });
let stop = false;
async function writeFile(d, name, bytes) {
  const fh = await d.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(bytes);
  await w.close();
}
const enginePad = async () => (await import("/kv/opfs/root.js")).openDbDir("repro");
globalThis.kc = {
  ready: true,
  async churn(reuse, engine) {
    if (engine) await enginePad();
    await dir("markers");
    await dir("pad");
    for (let i = 0; i < 2; i++) new Worker("/worker.js", { type: "module" }).postMessage({ id: i, reuse });
    const d = await dir("pw");
    for (let n = 0; !stop && !reuse; n++) {
      await writeFile(d, "w" + n, new Uint8Array(200 + (n % 50)));
      if (n >= 4) await d.removeEntry("w" + (n - 4));
    }
  },
  async markers(iter, k, opts) {
    const t0 = performance.now();
    if (opts.engine) await enginePad();
    const m = await dir("markers");
    if (opts.tiny) { await writeFile(m, "tiny-" + iter, new Uint8Array(1)); await new Promise((r) => setTimeout(r, 1000)); }
    if (opts.waitMs) await new Promise((r) => setTimeout(r, opts.waitMs));
    if (opts.pad) {
      const p = await dir("pad");
      for (let i = 0; i < opts.pad; i++) {
        await p.getFileHandle("p" + i, { create: true });
        await p.removeEntry("p" + i);
      }
    }
    const beforeMarkersMs = Math.round(performance.now() - t0);
    for (let j = 0; j < k; j++) await writeFile(m, "mk-" + iter + "-" + j, new TextEncoder().encode("marker " + iter + " " + j));
    let removed = 0;
    for (const sub of ["s0", "s1", "pw"]) {
      const d = await dir(sub);
      for await (const name of d.keys()) { if (removed++ % 2 === 0) await d.removeEntry(name).catch(() => {}); if (removed > 20) break; }
    }
    return beforeMarkersMs;
  },
  async list(iter) {
    const m = await dir("markers");
    const out = [];
    for await (const name of m.keys()) if (name.startsWith("mk-" + iter + "-")) out.push(name);
    return out.sort();
  },
};
</script>`;

const WORKER = `
self.onmessage = async ({ data: { id, reuse } }) => {
  const root = await navigator.storage.getDirectory();
  const d = await root.getDirectoryHandle("s" + id, { create: true });
  const live = [];
  for (let n = 0; ; n++) {
    const name = reuse ? "seg" + (n % 8) : "seg" + Date.now() + "-" + n;
    const fh = await d.getFileHandle(name, { create: true });
    const h = await fh.createSyncAccessHandle();
    h.truncate(0);
    h.write(new Uint8Array(64 + (n % 32)), { at: 0 });
    h.flush();
    h.close();
    if (reuse) continue;
    live.push(name);
    if (live.length > 8) await d.removeEntry(live.shift());
  }
};`;

async function startServer(): Promise<{ server: http.Server; origin: string }> {
  const server = http.createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0]!;
    const dist = url.startsWith("/kv/") ? path.join(import.meta.dirname, "..", "dist", url.slice(4)) : "";
    const body = url === "/worker.js" ? WORKER : url === "/" ? PAGE : dist && fs.existsSync(dist) ? fs.readFileSync(dist, "utf8") : null;
    if (body === null) return void res.writeHead(404).end();
    res.writeHead(200, {
      "content-type": url === "/" ? "text/html" : "text/javascript",
      "cache-control": "no-store",
    });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  return { server, origin: `http://127.0.0.1:${addr.port}` };
}

type Msg = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
  sessionId?: string;
};

class Cdp {
  private next = 1;
  private pending = new Map<number, { ok: (v: Record<string, unknown>) => void; fail: (e: Error) => void }>();
  private ws: WebSocket;
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as Msg;
      const p = msg.id === undefined ? undefined : this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id!);
      if (msg.error) p.fail(new Error(msg.error.message));
      else p.ok(msg.result ?? {});
    });
    ws.addEventListener("close", () => {
      for (const p of this.pending.values()) p.fail(new Error("cdp closed"));
      this.pending.clear();
    });
  }
  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => resolve(new Cdp(ws)), { once: true });
      ws.addEventListener("error", () => reject(new Error("cdp socket error")), { once: true });
    });
  }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    const id = this.next++;
    return new Promise((ok, fail) => {
      const t = setTimeout(() => (this.pending.delete(id), fail(new Error(`${method} timed out`))), timeoutMs);
      this.pending.set(id, {
        ok: (v) => (clearTimeout(t), ok(v)),
        fail: (e) => (clearTimeout(t), fail(e)),
      });
      this.ws.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  }
  fire(method: string, params: Record<string, unknown> = {}, sessionId?: string): void {
    this.send(method, params, sessionId, 5_000).catch(() => undefined);
  }
  close(): void {
    try {
      this.ws.close();
    } catch {}
  }
}

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

class Browser {
  readonly child: ChildProcess;
  readonly cdp: Cdp;
  readonly exited: Promise<void>;
  private constructor(child: ChildProcess, cdp: Cdp, exited: Promise<void>) {
    this.child = child;
    this.cdp = cdp;
    this.exited = exited;
  }

  static async launch(profile: string): Promise<Browser> {
    fs.rmSync(path.join(profile, "DevToolsActivePort"), { force: true });
    const child = spawn(
      CHROME,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-breakpad",
        "--disable-crash-reporter",
        "--remote-allow-origins=*",
        "--disable-background-timer-throttling",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "about:blank",
      ],
      { stdio: "ignore", detached: true },
    );
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    const file = path.join(profile, "DevToolsActivePort");
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        const [port, wsPath] = fs.readFileSync(file, "utf8").split("\n");
        if (port && wsPath) return new Browser(child, await Cdp.connect(`ws://127.0.0.1:${port}${wsPath}`), exited);
      } catch {}
      if (Date.now() > deadline) throw new Error("devtools not ready");
      await sleep(50);
    }
  }

  get pid(): number {
    return this.child.pid ?? 0;
  }

  group(): string[] {
    const out = execFileSync("ps", ["-A", "-o", "pid=,pgid=,command="], {
      encoding: "utf8",
    });
    return out
      .split("\n")
      .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => !!m && Number(m[2]) === this.pid)
      .map((m) => `${m[1]} ${/--utility-sub-type=(\S+)/.exec(m[3]!)?.[1] ?? /--type=(\S+)/.exec(m[3]!)?.[1] ?? "browser"}`);
  }

  async drain(): Promise<string[]> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && this.group().length > 0) await sleep(100);
    const left = this.group();
    try {
      process.kill(-this.pid, "SIGKILL");
    } catch {}
    await Promise.race([this.exited, sleep(5_000)]);
    this.cdp.close();
    return left;
  }

  async close(): Promise<{ exited: boolean; left: string[] }> {
    this.cdp.fire("Browser.close");
    const exited = await Promise.race([this.exited.then(() => true), sleep(10_000).then(() => false)]);
    return { exited, left: await this.drain() };
  }

  async crash(): Promise<string[]> {
    if (kill === "crash") this.cdp.fire("Browser.crash");
    else if (kill === "group") process.kill(-this.pid, "SIGKILL");
    else process.kill(this.pid, "SIGKILL");
    await Promise.race([this.exited, sleep(15_000)]);
    return this.drain();
  }

  async page(url: string): Promise<(expr: string, timeoutMs?: number) => Promise<unknown>> {
    const { targetId } = await this.cdp.send("Target.createTarget", {
      url: "about:blank",
    });
    const { sessionId } = (await this.cdp.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    })) as { sessionId: string };
    const evaluate = async (expression: string, timeoutMs = 30_000) => {
      const res = (await this.cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId, timeoutMs)) as {
        result?: { value?: unknown };
        exceptionDetails?: {
          exception?: { description?: string };
          text?: string;
        };
      };
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
      return res.result?.value;
    };
    await this.cdp.send("Page.navigate", { url }, sessionId);
    for (const deadline = Date.now() + 20_000; Date.now() < deadline; await sleep(50)) {
      if ((await evaluate("globalThis.kc?.ready === true", 2_000).catch(() => false)) === true) return evaluate;
    }
    throw new Error("page did not load");
  }
}

type LogState = {
  file: string;
  bytes: number;
  bad: { offset: number; why: string; dropped: number; text: string }[];
};

function pathsLogs(profile: string): LogState[] {
  const fsRoot = path.join(profile, "Default", "File System");
  if (!fs.existsSync(fsRoot)) return [];
  const out: LogState[] = [];
  for (const bucket of fs.readdirSync(fsRoot)) {
    const dir = path.join(fsRoot, bucket, "t", "Paths");
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".log"))) {
      const buf = new Uint8Array(fs.readFileSync(path.join(dir, f)));
      const phys = physicalRecords(buf);
      const bad = phys
        .filter((r) => !r.ok)
        .map((r) => ({
          offset: r.offset,
          why: r.why ?? "",
          dropped: r.dropped ?? 0,
          text: Buffer.from(buf.subarray(r.offset, r.offset + (r.dropped ?? 0))).toString("latin1"),
        }));
      out.push({ file: `${bucket}/${f}`, bytes: buf.length, bad });
    }
  }
  return out;
}

function fmt(logs: LogState[], iter: number): string {
  const markersIn = (text: string) => new Set(text.match(new RegExp(`mk-${iter}-\\d+`, "g")) ?? []).size;
  return logs
    .map(
      (l) =>
        `${l.file} ${l.bytes}B` +
        (l.bad.length
          ? ` BAD[${l.bad.map((b) => `@${b.offset} ${b.why}, drops ${b.dropped}B holding ${markersIn(b.text)} marker names`).join("; ")}]`
          : " clean"),
    )
    .join(", ");
}

async function main(): Promise<void> {
  const { server, origin } = await startServer();
  const version = execFileSync(CHROME, ["--version"], {
    encoding: "utf8",
  }).trim();
  console.log(`${version}, mode ${mode}, kill ${kill}, ${iterations} iterations, ${markers} markers, origin ${origin}`);
  let profile = "";
  let lost = 0;
  let tornAfterKill = 0;
  let tornAndLost = 0;
  const lostIters: number[] = [];
  const profiles: string[] = [];
  for (let iter = 0; iter < iterations; iter++) {
    if (iter % rotate === 0) {
      profile = fs.mkdtempSync(path.join(os.tmpdir(), "opfs-loss-"));
      profiles.push(profile);
    }

    let b = await Browser.launch(profile);
    let run = await b.page(origin + "/");
    void run(`kc.churn(${mode === "reuse"}, ${mode === "engine"})`, 60_000).catch(() => undefined);
    await sleep(500 + Math.floor(Math.random() * 2500));
    const leftA = await b.crash();
    const afterKill = pathsLogs(profile);
    const torn = afterKill.some((l) => l.bad.length > 0);
    if (torn) tornAfterKill++;

    if (mode === "idle") {
      b = await Browser.launch(profile);
      await b.page(origin + "/");
      await b.close();
    }

    b = await Browser.launch(profile);
    run = await b.page(origin + "/");
    const beforeMarkersMs = (await run(
      `kc.markers(${iter}, ${markers}, ${JSON.stringify({ tiny: mode === "tiny", waitMs: mode === "wait" ? waitMs : 0, pad: mode === "pad" ? pad : 0, engine: mode === "engine" })})`,
      120_000,
    )) as number;
    const closeB = await b.close();
    const afterB = pathsLogs(profile);

    b = await Browser.launch(profile);
    run = await b.page(origin + "/");
    const found = (await run(`kc.list(${iter})`)) as string[];
    await b.close();
    const afterC = pathsLogs(profile);

    const missing = markers - found.length;
    if (missing > 0) {
      lost++;
      lostIters.push(iter);
      if (torn) tornAndLost++;
    }
    console.log(
      `iter ${iter}: ${missing > 0 ? `LOST ${missing}/${markers}` : "ok"} (${beforeMarkersMs} ms before the markers)` +
        `${leftA.length ? ` (helpers left after kill: ${leftA.join(",")})` : ""}` +
        `${!closeB.exited || closeB.left.length ? ` (B close exited=${closeB.exited} left=${closeB.left.join(",")})` : ""}` +
        `\n  after kill: ${fmt(afterKill, iter)}\n  after B:    ${fmt(afterB, iter)}\n  after C:    ${fmt(afterC, iter)}`,
    );
  }
  server.close();
  console.log(
    `\n${version} mode=${mode} kill=${kill}: lost markers in ${lost}/${iterations} iterations [${lostIters.join(",")}]; ` +
      `Paths log torn after the kill in ${tornAfterKill}/${iterations}; lost given torn ${tornAndLost}/${tornAfterKill}`,
  );
  if (keep) console.log(`profiles kept: ${profiles.join(" ")}`);
  else for (const p of profiles) fs.rmSync(p, { recursive: true, force: true });
}

await main();

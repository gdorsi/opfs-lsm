/**
 * Cold reload of the app on each storage, painted from the persisted cache with the server unreachable.
 *
 *   node examples/linearlite-fate/bench/reload.ts <origin> [--reps N] [--windows N]
 *
 * <origin> serves a production build with a seeded database. Each storage gets its own Chrome profile: one
 * prepare run fills the cache while the server answers, then every rep starts a new Chrome process on that
 * profile, blocks /api/fate, and times the first list row from navigation start. The last rep then scrolls to a
 * window that prepare visited and requires its rows.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FLAGS = [
  "--headless=new",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--disable-sync",
  "--disable-background-networking",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
];
const KINDS = ["kv", "idb"] as const;
type Kind = (typeof KINDS)[number];
const MARKS = ["fate:open-start", "fate:storage-open", "fate:ready"] as const;
const ROW_HEIGHT = 40;
const STEP_ROWS = 150;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { reps: { type: "string", default: "7" }, windows: { type: "string", default: "20" } },
});
const origin = positionals[0];
const reps = Number(values.reps);
const windows = Number(values.windows);
if (!origin || !Number.isInteger(reps) || reps < 1 || !Number.isInteger(windows) || windows < 1) {
  console.error("usage: node reload.ts <origin> [--reps N] [--windows N]");
  process.exit(2);
}

type Page = { evaluate<T>(js: string): Promise<T> };
type Chrome = { open(url: string, opts?: { blockApi: boolean }): Promise<Page>; close(): Promise<void> };

async function launch(profile: string): Promise<Chrome> {
  const portFile = join(profile, "DevToolsActivePort");
  rmSync(portFile, { force: true }); // left by the previous process on this profile
  const child: ChildProcess = spawn(CHROME, [...FLAGS, `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], {
    detached: true,
    stdio: "ignore",
  });
  for (let i = 0; !existsSync(portFile); i++) {
    if (i > 800 || child.exitCode !== null) throw new Error("Chrome did not open a debugging port");
    await sleep(25);
  }
  const port = readFileSync(portFile, "utf8").split("\n")[0];
  const { webSocketDebuggerUrl } = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("CDP connect failed"));
  });
  let nextId = 1;
  const pending = new Map<number, { resolve(v: any): void; reject(e: Error): void }>();
  const listeners: Array<(method: string, sessionId?: string) => void> = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id === undefined) return void listeners.forEach((l) => l(msg.method, msg.sessionId));
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p?.reject(new Error(msg.error.message));
    else p?.resolve(msg.result);
  };
  const send = <T>(method: string, params: object = {}, sessionId?: string) =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });

  return {
    async open(url, { blockApi } = { blockApi: false }) {
      const { targetId } = await send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
      await send("Page.enable", {}, sessionId);
      if (blockApi) {
        await send("Network.enable", {}, sessionId);
        await send("Network.setBlockedURLs", { urls: ["*/api/fate*"] }, sessionId);
      }
      // Stamps the shell and the first list row from inside the page, so the times do not include a CDP round trip.
      await send("Page.addScriptToEvaluateOnNewDocument", { source: FIRST_ROW }, sessionId);
      const loaded = new Promise<void>((resolve) => {
        listeners.push(function on(method, sid) {
          if (method !== "Page.loadEventFired" || sid !== sessionId) return;
          listeners.splice(listeners.indexOf(on), 1);
          resolve();
        });
      });
      await send("Page.navigate", { url }, sessionId);
      await Promise.race([loaded, sleep(30_000).then(() => Promise.reject(new Error("page did not load")))]);
      return {
        async evaluate<T>(js: string) {
          const r = await send<{ result: { value: T }; exceptionDetails?: { exception?: { description?: string }; text: string } }>(
            "Runtime.evaluate",
            { expression: js, awaitPromise: true, returnByValue: true },
            sessionId,
          );
          if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
          return r.result.value;
        },
      };
    },
    async close() {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      await send("Browser.close").catch(() => {});
      await Promise.race([exited, sleep(10_000)]);
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
    },
  };
}

const FIRST_ROW = `(() => {
  new MutationObserver((_, obs) => {
    if (globalThis.__shell === undefined && document.querySelector(".app")) globalThis.__shell = performance.now();
    if (!document.querySelector(".row[data-id]")) return;
    globalThis.__firstRow = performance.now();
    obs.disconnect();
  }).observe(document, { childList: true, subtree: true });
})()`;

const WAIT = `const until = async (what, ok, ms = 30000) => {
  for (const t0 = performance.now(); !ok(); await new Promise((r) => setTimeout(r, 20)))
    if (performance.now() - t0 > ms) throw new Error("timed out waiting for " + what);
};`;

async function prepare(kind: Kind, profile: string): Promise<{ total: string; records: number }> {
  const chrome = await launch(profile);
  try {
    const page = await chrome.open(`${origin}/?storage=${kind}&bench`);
    return await page.evaluate(`(async () => {
      ${WAIT}
      const scroller = () => document.querySelector("#scroller");
      const loaded = (index) => document.querySelector('.row[data-index="' + index + '"]') && !document.querySelector("[data-skeleton]");
      await until("the first rows", () => loaded(0));
      for (let i = 1; i <= ${windows}; i++) {
        scroller().scrollTop = i * ${STEP_ROWS} * ${ROW_HEIGHT};
        await until("window " + i, () => loaded(i * ${STEP_ROWS}));
      }
      scroller().scrollTop = 0;
      await until("the top", () => loaded(0));
      await until("the total", () => document.querySelector("#count").textContent);
      await globalThis.linearliteFate.persistence.flush();
      const part = (tagged, key) => tagged[1].find(([k]) => k === key)?.[1];
      const records = part(part(globalThis.linearliteFate.dehydrate().data, "store"), "records")[1].length;
      return { total: document.querySelector("#count").textContent, records };
    })()`);
  } finally {
    await chrome.close();
  }
}

type Rep = { open: number; ready: number; shell: number; firstRow: number };

/** One cold start with the server unreachable; throws when the paint cannot have come from the cache. */
async function measure(kind: Kind, profile: string, total: string, visit: boolean): Promise<Rep> {
  const chrome = await launch(profile);
  try {
    const page = await chrome.open(`${origin}/?storage=${kind}`, { blockApi: true });
    const r = await page.evaluate<{ marks: Record<string, number | undefined>; shell?: number; firstRow?: number; rows: number; total: string; api: string; visited: boolean }>(`(async () => {
      ${WAIT}
      await until("a list row", () => globalThis.__firstRow !== undefined, 20000);
      await until("the total", () => document.querySelector("#count").textContent, 5000);
      const api = await fetch("/api/fate", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then(() => "reachable", () => "blocked");
      const marks = Object.fromEntries(${JSON.stringify(MARKS)}.map((n) => [n, performance.getEntriesByName(n)[0]?.startTime]));
      const rows = document.querySelectorAll(".row[data-id]").length;
      const shown = document.querySelector("#count").textContent;
      let visited = true;
      if (${visit}) {
        const index = ${Math.ceil(windows / 2) * STEP_ROWS};
        document.querySelector("#scroller").scrollTop = index * ${ROW_HEIGHT};
        visited = await until("a visited window", () => document.querySelector('.row[data-index="' + index + '"]'), 5000).then(() => true, () => false);
      }
      return { marks, shell: globalThis.__shell, firstRow: globalThis.__firstRow, rows, total: shown, api, visited };
    })()`);
    const [start, open, ready] = MARKS.map((m) => r.marks[m]);
    if (r.api !== "blocked") throw new Error("the API was reachable");
    if (r.total !== total) throw new Error(`total ${r.total}, the cache held ${total}`);
    if (!r.visited) throw new Error("a window that prepare visited did not paint from the cache");
    if (r.rows === 0 || start === undefined || open === undefined || ready === undefined || r.shell === undefined || r.firstRow === undefined) throw new Error(`incomplete: ${JSON.stringify(r)}`);
    return { open, ready, shell: r.shell, firstRow: r.firstRow };
  } finally {
    await chrome.close();
  }
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
const range = (xs: number[]) => `${Math.min(...xs).toFixed(0)}-${Math.max(...xs).toFixed(0)}`;
const cell = (xs: number[]) => `${median(xs).toFixed(0)} (${range(xs)})`.padEnd(16);

const profiles = Object.fromEntries(KINDS.map((k) => [k, mkdtempSync(join(tmpdir(), `linearlite-fate-${k}-`))])) as Record<Kind, string>;
const good: Record<Kind, Rep[]> = { kv: [], idb: [] };
const errors: Record<Kind, number> = { kv: 0, idb: 0 };
const totals = {} as Record<Kind, string>;
try {
  for (const kind of KINDS) {
    const { total, records } = await prepare(kind, profiles[kind]);
    totals[kind] = total;
    console.log(`prepared ${kind}: list total ${total}, ${records} records in fate's memory store at flush`);
  }
  for (let rep = 1; rep <= reps; rep++) {
    for (const kind of KINDS) {
      try {
        const r = await measure(kind, profiles[kind], totals[kind], rep === reps);
        good[kind].push(r);
        console.log(`rep ${rep} ${kind}: open ${r.open.toFixed(0)} ready ${r.ready.toFixed(0)} shell ${r.shell.toFixed(0)} first row ${r.firstRow.toFixed(0)} ms`);
      } catch (e) {
        errors[kind]++;
        console.log(`rep ${rep} ${kind}: ERROR ${(e as Error).message}`);
      }
    }
  }
} finally {
  for (const dir of Object.values(profiles)) rmSync(dir, { recursive: true, force: true });
}

console.log(`\nms from navigation start: median (min-max), ${reps} reps alternating kv and idb\n`);
console.log("storage  storage-open     ready            shell            first row        good  errors");
for (const kind of KINDS) {
  const g = good[kind];
  const row = g.length ? [cell(g.map((r) => r.open)), cell(g.map((r) => r.ready)), cell(g.map((r) => r.shell)), cell(g.map((r) => r.firstRow))] : Array(4).fill("-".padEnd(16));
  console.log(`${kind.padEnd(8)} ${row.join(" ")} ${String(g.length).padEnd(5)} ${errors[kind]}`);
}
console.log("idb opens its database inside restore, so its storage-open mark is early; compare ready.");

if (!good.kv.length || !good.idb.length) {
  console.log("\nno verdict: a storage has no good rep");
} else {
  const first = (k: Kind) => good[k].map((r) => r.firstRow);
  const stage = (k: Kind) => ({
    "storage open": median(good[k].map((r) => r.open)),
    restore: median(good[k].map((r) => r.ready - r.open)),
    "wait for the shell": median(good[k].map((r) => r.shell - r.ready)),
    "list restore and render": median(good[k].map((r) => r.firstRow - r.shell)),
  });
  const [kv, idb] = [stage("kv"), stage("idb")];
  const [stageName, delta] = Object.entries(kv)
    .map(([name, v]) => [name, v - idb[name as keyof typeof idb]] as const)
    .reduce((a, b) => (Math.abs(b[1]) > Math.abs(a[1]) ? b : a));
  const diff = median(first("kv")) - median(first("idb"));
  const overlap = Math.min(...first("kv")) <= Math.max(...first("idb")) && Math.min(...first("idb")) <= Math.max(...first("kv"));
  const verdict = overlap ? "no measurable difference" : diff < 0 ? "kv is faster" : "kv is slower";
  console.log(`\nverdict: ${verdict}. First row, kv minus idb: ${diff.toFixed(0)} ms at the median; the ranges ${overlap ? "overlap" : "do not overlap"}.`);
  console.log(`largest stage gap: ${stageName}, ${delta.toFixed(0)} ms (kv minus idb at the median).`);
}

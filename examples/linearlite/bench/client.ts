// usage: node bench/client.ts <origin> <scenario...>
// Drives headless Chrome over CDP with agent-browser against a seeded `vite dev`. Scenarios: page-size, first-sync,
// visible, warm, tabs, users, offline. Each prints JSON lines; times are ms.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const [origin = "http://127.0.0.1:4180", ...scenarios] = process.argv.slice(2);
let nextPort = 9400;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `target` is a session, or `session@tN` to run in that tab of the session. */
function ab(target: string, ...args: string[]): string {
  const [session, tab] = target.split("@") as [string, string | undefined];
  const run = (a: string[]) => execFileSync("agent-browser", ["--session", session, ...a], { encoding: "utf8", maxBuffer: 1 << 26 }).trim();
  if (tab) run(["tab", tab]);
  return run(args);
}

function evaluate<T>(session: string, js: string): T {
  const out = ab(session, "eval", js);
  const once = JSON.parse(out) as unknown;
  if (typeof once !== "string") return once as T;
  try {
    return JSON.parse(once) as T;
  } catch {
    return once as T;
  }
}

interface Browser {
  readonly session: string;
  readonly profile: string;
  readonly proc: ChildProcess;
}

async function launch(session: string, profile = mkdtempSync(join(tmpdir(), "linearlite-"))): Promise<Browser> {
  const port = nextPort++;
  const proc = spawn(CHROME, ["--headless=new", "--disable-gpu", `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "about:blank"], {
    stdio: "ignore",
  });
  await sleep(1500);
  ab(session, "connect", String(port));
  const url = ab(session, "get", "cdp-url");
  if (!url.includes(`:${port}/`)) throw new Error(`${session} connected to ${url}, not port ${port}`);
  return { session, profile, proc };
}

async function quit(b: Browser, keepProfile = false): Promise<void> {
  try {
    ab(b.session, "close");
  } catch {}
  b.proc.kill();
  await new Promise((r) => b.proc.once("exit", r));
  if (!keepProfile) rmSync(b.profile, { recursive: true, force: true });
}

const marks = `JSON.stringify(Object.fromEntries(performance.getEntriesByType("mark").map((m) => [m.name.replace("linearlite:", ""), Math.round(m.startTime)])))`;

async function waitFor<T>(what: string, poll: () => T | undefined, timeoutMs = 180_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = poll();
    if (v !== undefined) return v;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const waitMark = (b: Browser, name: string) =>
  waitFor(name, () => {
    const m = evaluate<Record<string, number>>(b.session, marks);
    return m[name] === undefined ? undefined : m;
  });

function summary(values: number[]) {
  const v = values.toSorted((a, b) => a - b);
  const round = (x: number) => Math.round(x * 10) / 10;
  return { n: v.length, p50: round(v[Math.floor((v.length - 1) / 2)]!), min: round(v[0]!), max: round(v.at(-1)!) };
}

const print = (o: unknown) => console.log(JSON.stringify(o));

async function firstSync(pull: number, keep = false, user = "ann"): Promise<{ browser: Browser; marks: Record<string, number>; heapMB: number }> {
  const b = await launch(`first-${user}`);
  ab(b.session, "open", `${origin}/issues?pull=${pull}&user=${user}`);
  const m = await waitMark(b, "caught-up:comments");
  const heapMB = evaluate<number>(b.session, "Math.round(performance.memory.usedJSHeapSize / 1e6)");
  if (!keep) await quit(b);
  return { browser: b, marks: m, heapMB };
}

/** Status edits through the real command, timed to the live query's change callback and to the DOM cell. */
const VISIBLE = `(async () => {
  const { store, commands, createLiveQueryCollection } = globalThis.__linearlite;
  const lq = createLiveQueryCollection((q) => q.from({ i: store.issues }).orderBy(({ i }) => i.modified, "desc").limit(100));
  await lq.preload();
  const labels = ["Backlog", "Todo", "In Progress", "Done", "Canceled"];
  const out = [];
  for (const { id, status } of lq.toArray.slice(20, 40)) {
    const next = (status + 1) % 5;
    const query = new Promise((resolve) => {
      const sub = lq.subscribeChanges((cs) => {
        if (cs.some((c) => c.key === id && c.value.status === next)) { sub.unsubscribe(); resolve(performance.now()); }
      });
    });
    const dom = new Promise((resolve) => {
      const mo = new MutationObserver(() => {
        if (document.querySelector("#issue-" + CSS.escape(id) + " .status")?.textContent === labels[next]) { mo.disconnect(); resolve(performance.now()); }
      });
      mo.observe(document.querySelector("tbody"), { subtree: true, childList: true, characterData: true });
    });
    const t0 = performance.now();
    await commands.setStatus(id, next);
    const [tq, td] = await Promise.all([query, dom]);
    out.push({ query: tq - t0, dom: td - t0 });
    await new Promise((r) => setTimeout(r, 50));
  }
  lq.cleanup();
  return JSON.stringify(out);
})()`;

const now = "performance.timeOrigin + performance.now()";

/** Installs a waiter for `id` reaching `status` in this tab's issues collection; read it back with `seenAt`. */
const watch = (id: string, status: number) => `(() => {
  const { store } = globalThis.__linearlite;
  globalThis.__seen = new Promise((resolve) => {
    const sub = store.issues.subscribeChanges((cs) => {
      if (cs.some((c) => c.key === ${JSON.stringify(id)} && c.value.status === ${status})) { sub.unsubscribe(); resolve(${now}); }
    });
  });
  return "1";
})()`;
const seenAt = `(async () => String(await globalThis.__seen))()`;
const edit = (id: string, status: number) => `(async () => { const t = ${now}; await globalThis.__linearlite.commands.setStatus(${JSON.stringify(id)}, ${status}); return String(t); })()`;
const pickIssue = (offset: number) =>
  `(() => { const r = globalThis.__linearlite.store.issues.toArray.filter((i) => !i.dirty)[${offset}]; return JSON.stringify({ id: r.id, status: r.status }); })()`;

/** Edit in `from`, time until `to` shows it, `runs` times. */
function crossEdits(from: string, to: string, runs: number, wait: (to: string) => number): number[] {
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const { id, status } = evaluate<{ id: string; status: number }>(from, pickIssue(100 + i));
    const next = (status + 1) % 5;
    evaluate(to, watch(id, next));
    const t0 = Number(evaluate<string>(from, edit(id, next)));
    times.push(wait(to) - t0);
  }
  return times;
}

const serverIssue = async (id: string) => {
  const res = (await (await fetch(`${origin}/api/pull?stream=issues&after=0&limit=10000`)).json()) as { head: number };
  let after = Math.max(0, res.head - 50_000);
  for (;;) {
    const page = (await (await fetch(`${origin}/api/pull?stream=issues&after=${after}&limit=10000`)).json()) as {
      rows: { id: string; status: number }[];
      more: boolean;
      next: number;
    };
    const hit = page.rows.findLast((r) => r.id === id);
    if (hit || !page.more) return hit;
    after = page.next;
  }
};

const run: Record<string, () => Promise<void>> = {
  async "page-size"() {
    for (const pull of [5000, 2000, 1000, 5000, 2000, 1000, 5000, 2000, 1000]) {
      const { marks: m, heapMB } = await firstSync(pull);
      print({ scenario: "page-size", pull, ...m, heapMB });
    }
  },

  async "first-sync"() {
    const rows: Record<string, number>[] = [];
    for (let i = 0; i < 3; i++) {
      const { marks: m, heapMB } = await firstSync(Number(process.env.PULL ?? 2000));
      rows.push(m);
      print({ scenario: "first-sync", run: i, ...m, heapMB });
    }
    for (const k of ["first-rows", "caught-up:issues", "caught-up:bodies", "caught-up:comments"]) {
      print({ scenario: "first-sync", metric: k, ...summary(rows.map((r) => r[k]!)) });
    }
  },

  async visible() {
    const { browser: b } = await firstSync(2000, true);
    const all: { query: number; dom: number }[] = [];
    for (let round = 0; round < 3; round++) {
      const out = evaluate<{ query: number; dom: number }[]>(b.session, VISIBLE);
      all.push(...out);
      print({ scenario: "visible", round, query: summary(out.map((o) => o.query)), dom: summary(out.map((o) => o.dom)) });
    }
    print({ scenario: "visible", all: true, query: summary(all.map((o) => o.query)), dom: summary(all.map((o) => o.dom)) });
    await quit(b);
  },

  async warm() {
    const { browser: first } = await firstSync(2000, true);
    await quit(first, true);
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const b = await launch("warm", first.profile);
      ab(b.session, "network", "route", "**/api/**", "--abort");
      ab(b.session, "open", `${origin}/issues`);
      const m = await waitMark(b, "first-rows");
      const sync = evaluate<string>(b.session, `document.querySelector("#sync").textContent`);
      const rows = evaluate<number>(b.session, `document.querySelectorAll("tbody tr").length`);
      times.push(m["first-rows"]!);
      print({ scenario: "warm", run: i, ...m, rows, sync });
      await quit(b, true);
    }
    print({ scenario: "warm", metric: "first-rows", ...summary(times) });
    rmSync(first.profile, { recursive: true, force: true });
  },

  async tabs() {
    const { browser: b } = await firstSync(2000, true);
    const A = `${b.session}@t1`;
    const B = `${b.session}@t2`;
    ab(b.session, "tab", "new", `${origin}/issues`);
    await waitFor("tab B rows", () => (evaluate<number>(B, `document.querySelectorAll("tbody tr").length`) > 0 ? true : undefined));
    print({ scenario: "tabs", leaderA: "leader" in evaluate<Record<string, number>>(A, marks), leaderB: "leader" in evaluate<Record<string, number>>(B, marks) });
    const read = (s: string) => Number(evaluate<string>(s, seenAt));
    print({ scenario: "tabs", metric: "A->B", ...summary(crossEdits(A, B, 10, read)) });
    print({ scenario: "tabs", metric: "B->A", ...summary(crossEdits(B, A, 10, read)) });

    ab(A, "set", "offline", "on");
    const { id, status } = evaluate<{ id: string; status: number }>(B, pickIssue(500));
    const next = (status + 1) % 5;
    evaluate(B, edit(id, next));
    await sleep(3000);
    const pending = evaluate<boolean>(B, `!!globalThis.__linearlite.store.issues.get(${JSON.stringify(id)}).dirty`);
    const serverBefore = (await serverIssue(id))?.status;
    const tClose = Date.now();
    const port = new URL(ab(b.session, "get", "cdp-url")).port;
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { id: string; url: string }[];
    const leader = targets.find((t) => t.url.includes("pull=2000"));
    if (!leader) throw new Error("no leader tab");
    await fetch(`http://127.0.0.1:${port}/json/close/${leader.id}`);
    ab(b.session, "tab", "t2");
    await waitFor("B to lead", () => ("leader" in evaluate<Record<string, number>>(B, marks) ? true : undefined), 30_000);
    await waitFor("B to push", () => (evaluate<boolean>(B, `!globalThis.__linearlite.store.issues.get(${JSON.stringify(id)}).dirty`) ? true : undefined), 30_000);
    const pushedMs = Date.now() - tClose;
    print({ scenario: "tabs", handover: { pendingWhileLeaderOffline: pending, serverBefore, serverAfter: (await serverIssue(id))?.status, expected: next, closeToAckedMs: pushedMs } });
    await quit(b);
  },

  async users() {
    const one = await firstSync(2000, true);
    const two = await firstSync(2000, true, "bob");
    const times = crossEdits(two.browser.session, one.browser.session, 10, (s) => Number(evaluate<string>(s, seenAt)));
    print({ scenario: "users", metric: "bob->ann", ...summary(times) });
    await quit(one.browser);
    await quit(two.browser);
  },

  async offline() {
    const { browser: b } = await firstSync(2000, true);
    ab(b.session, "set", "offline", "on");
    const edits = [0, 1, 2].map((i) => {
      const { id, status } = evaluate<{ id: string; status: number }>(b.session, pickIssue(300 + i));
      const next = (status + 1) % 5;
      evaluate(b.session, edit(id, next));
      return { id, next };
    });
    await sleep(4000);
    const ids = JSON.stringify(edits.map((e) => e.id));
    const dirtyOffline = evaluate<boolean[]>(b.session, `JSON.stringify(${ids}.map((id) => !!globalThis.__linearlite.store.issues.get(id).dirty))`);
    const statusOffline = evaluate<string>(b.session, `document.querySelector("#sync").textContent`);
    const serverOffline = await Promise.all(edits.map((e) => serverIssue(e.id).then((r) => r?.status)));
    const t0 = Date.now();
    ab(b.session, "set", "offline", "off");
    await waitFor("acks", () =>
      evaluate<boolean[]>(b.session, `JSON.stringify(${ids}.map((id) => !globalThis.__linearlite.store.issues.get(id).dirty))`).every(Boolean) ? true : undefined,
    );
    const ackMs = Date.now() - t0;
    const serverOnline = await Promise.all(edits.map((e) => serverIssue(e.id).then((r) => r?.status)));
    print({
      scenario: "offline",
      expected: edits.map((e) => e.next),
      dirtyOffline,
      statusOffline,
      serverOffline,
      reconnectToAckedMs: ackMs,
      serverOnline,
      statusOnline: evaluate<string>(b.session, `document.querySelector("#sync").textContent`),
    });
    await quit(b);
  },
};

for (const name of scenarios) {
  const go = run[name];
  if (!go) throw new Error(`unknown scenario ${name}; one of ${Object.keys(run).join(", ")}`);
  await go();
}

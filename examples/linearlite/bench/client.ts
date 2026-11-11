import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const [origin = "http://127.0.0.1:4180", ...scenarios] = process.argv.slice(2);
const RUNS = Number(process.env.RUNS ?? 3);
const PROFILE = process.env.PROFILE;
const SESSION = process.env.SESSION_PREFIX ?? "";
let nextPort = Number(process.env.CDP_PORT ?? 9400);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** Whether a Chrome left over from another run holds `port`: agent-browser would drive that one instead. */
const listening = (port: number) =>
  fetch(`http://127.0.0.1:${port}/json/version`).then(
    () => true,
    () => false,
  );

/**
 * Chrome on `profile`, driven by agent-browser. `initScript` runs before each page's own scripts; it is registered when
 * agent-browser connects, since `open --init-script` opens the page in a fresh browser context, with empty storage and
 * without the session's network routes.
 */
async function launch(name: string, profile = mkdtempSync(join(tmpdir(), "linearlite-")), initScript?: string): Promise<Browser> {
  const session = SESSION + name;
  let port = nextPort++;
  while (await listening(port)) port = nextPort++;
  const flags = ["--headless=new", "--disable-gpu", "--enable-precise-memory-info", "--js-flags=--expose-gc"];
  const proc = spawn(CHROME, [...flags, `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "about:blank"], { stdio: "ignore" });
  const browser = { session, profile, proc };
  try {
    await waitFor(`Chrome on port ${port}`, async () => ((await listening(port)) ? true : undefined), 30_000);
    ab(session, ...(initScript ? ["--init-script", initScript] : []), "connect", String(port));
    const url = ab(session, "get", "cdp-url");
    if (!url.includes(`:${port}/`)) throw new Error(`${session} connected to ${url}, not port ${port}`);
    return browser;
  } catch (err) {
    await quit(browser, true);
    throw err;
  }
}

async function quit(b: Browser, keepProfile = false): Promise<void> {
  try {
    ab(b.session, "close");
  } catch {}
  if (b.proc.exitCode === null && b.proc.signalCode === null) {
    const exited = new Promise((r) => b.proc.once("exit", r));
    b.proc.kill();
    await exited;
  }
  if (!keepProfile) rmSync(b.profile, { recursive: true, force: true });
}

const marks = `JSON.stringify(Object.fromEntries(performance.getEntriesByType("mark").map((m) => [m.name.replace("linearlite:", ""), Math.round(m.startTime)])))`;

/** Heap after a full GC and the origin's storage use, in MB. */
const footprint = `(async () => { globalThis.gc?.(); await new Promise((r) => setTimeout(r, 100)); return JSON.stringify({ heapMB: Math.round(performance.memory.usedJSHeapSize / 1e6), storageMB: Math.round((await navigator.storage.estimate()).usage / 1e6) }); })()`;

async function waitFor<T>(what: string, poll: () => T | undefined | Promise<T | undefined>, timeoutMs = 180_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await poll();
    if (v !== undefined) return v;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const waitMark = (b: Browser, name: string, timeoutMs?: number) =>
  waitFor(
    name,
    () => {
      const m = evaluate<Record<string, number>>(b.session, marks);
      return m[name] === undefined ? undefined : m;
    },
    timeoutMs,
  );

function summary(values: number[]) {
  const v = values.toSorted((a, b) => a - b);
  const round = (x: number) => Math.round(x * 10) / 10;
  return { n: v.length, p50: round(v[Math.floor((v.length - 1) / 2)]!), min: round(v[0]!), max: round(v.at(-1)!) };
}

const print = (o: unknown) => console.log(JSON.stringify(o));

type ServerIssue = { id: string; title: string; status: number; priority: number; created: number; modified: number; deleted: boolean; version: number };

/** Every issue as the server holds it now, live ones only. */
async function serverIssues(): Promise<ServerIssue[]> {
  const latest = new Map<string, ServerIssue>();
  for (let after = 0; ; ) {
    const page = (await (await fetch(`${origin}/api/pull?stream=issues&after=${after}&limit=10000`)).json()) as { rows: ServerIssue[]; more: boolean; next: number };
    for (const r of page.rows) latest.set(r.id, r);
    if (!page.more) break;
    after = page.next;
  }
  return [...latest.values()].filter((i) => !i.deleted);
}

const SEARCH_PAIRS = [["of", "off"], ["ta", "tab"], ["ma", "mag"], ["cu", "cur"], ["ni", "nis"], ["ex", "exc"], ["do", "dol"], ["in", "ind"], ["qu", "que"], ["la", "lab"], ["re", "ren"], ["se", "sed"], ["co", "com"], ["su", "sun"]];

/** What `bench/ui-latency.js` checks each step against. */
function truthOf(issues: ServerIssue[]) {
  const titles = issues.map((i) => i.title.toLowerCase());
  const matching = (q: string) => titles.filter((t) => t.includes(q)).length;
  const per = (field: "status" | "priority") => [0, 1, 2, 3, 4].map((k) => issues.filter((i) => i[field] === k).length);
  const top = (field: "created" | "modified") => {
    const max = Math.max(...issues.map((i) => i[field]));
    return issues.filter((i) => i[field] === max).map((i) => i.id);
  };
  const byModified = issues.toSorted((a, b) => b.modified - a.modified);
  const at = (target: number) => byModified.filter((i) => i.modified === byModified[target]!.modified).map((i) => i.id);
  return {
    total: issues.length,
    byStatus: per("status"),
    byPriority: per("priority"),
    topCreated: top("created"),
    topModified: top("modified"),
    search: SEARCH_PAIRS.map(([before, term]) => ({ before: before!, term: term!, count: matching(term!), was: matching(before!) }))
      .filter((p) => p.count !== p.was)
      .slice(0, 10),
    jumps: [
      { target: 5000, ids: at(5000), runs: 10 },
      { target: 50_000, ids: at(50_000), runs: 5 },
    ],
  };
}

/** Marks `bench:rows-total` once a list row is in the DOM and the toolbar shows `total`, the server's count. */
const rowsTotalWatcher = (total: number) => `(() => {
  const want = ${JSON.stringify(total.toLocaleString("en-US"))};
  const mo = new MutationObserver(() => {
    if (document.getElementById("count")?.textContent === want && document.querySelector(".row[data-id]")) {
      performance.mark("bench:rows-total");
      mo.disconnect();
    }
  });
  mo.observe(document, { subtree: true, childList: true, characterData: true });
})()`;

async function firstSync(pull: number, keep = false, user = "ann"): Promise<{ browser: Browser; marks: Record<string, number>; heapMB: number; storageMB: number }> {
  const b = await launch(`first-${user}`);
  try {
    ab(b.session, "open", `${origin}/issues?pull=${pull}&user=${user}`);
    const m = await waitMark(b, "caught-up:comments");
    const { heapMB, storageMB } = evaluate<{ heapMB: number; storageMB: number }>(b.session, footprint);
    if (!keep) await quit(b);
    return { browser: b, marks: m, heapMB, storageMB };
  } catch (err) {
    await quit(b);
    throw err;
  }
}

/** A profile holding a synced replica: `PROFILE`, or a fresh one filled by a first sync and kept. */
async function syncedProfile(): Promise<{ profile: string; owned: boolean }> {
  if (PROFILE) return { profile: PROFILE, owned: false };
  const { browser } = await firstSync(2000, true);
  await quit(browser, true);
  return { profile: browser.profile, owned: true };
}

/** A warm start with the network to /api cut: the list renders from the replica alone. */
async function warmStart(name: string, profile: string, total: number): Promise<Browser> {
  const watcher = join(mkdtempSync(join(tmpdir(), "linearlite-watch-")), "rows-total.js");
  writeFileSync(watcher, rowsTotalWatcher(total));
  const b = await launch(name, profile, watcher);
  try {
    ab(b.session, "network", "route", "**/api/**", "--abort");
    ab(b.session, "open", `${origin}/issues`);
    return b;
  } catch (err) {
    await quit(b, true);
    throw err;
  }
}

/** Throws if a warm page reached the server: its numbers would include a sync. */
function offline(b: Browser): void {
  const served = evaluate<number>(b.session, `performance.getEntriesByType("resource").filter((e) => e.name.includes("/api/") && e.responseStatus > 0).length`);
  if (served > 0) throw new Error(`${b.session}: ${served} /api requests were served on a warm start`);
}

const VISIBLE = `(async () => {
  const { store, commands, createLiveQueryCollection, eq } = globalThis.__linearlite;
  const lq = createLiveQueryCollection((q) => q.from({ i: store.issues }).where(({ i }) => eq(i.deleted, false)).orderBy(({ i }) => i.modified, "desc").limit(100));
  await lq.preload();
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
        if (document.querySelector("#issue-" + CSS.escape(id))?.getAttribute("data-status") === String(next)) { mo.disconnect(); resolve(performance.now()); }
      });
      mo.observe(document.querySelector(".rows"), { subtree: true, childList: true, attributes: true, attributeFilter: ["data-status"] });
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
const issueDocs = "globalThis.__linearlite.store.docs.collection('issues')";

/** Loads issue `id` in this tab, then resolves `__seen` when this tab's collection shows it with `status`. */
const watch = (id: string, status: number) => `(async () => {
  const { store, createLiveQueryCollection, eq } = globalThis.__linearlite;
  const one = createLiveQueryCollection((q) => q.from({ i: store.issues }).where(({ i }) => eq(i.id, ${JSON.stringify(id)})));
  await one.preload();
  globalThis.__seen = new Promise((resolve) => {
    const sub = one.subscribeChanges((cs) => {
      if (cs.some((c) => c.value?.status === ${status})) { sub.unsubscribe(); void one.cleanup(); resolve(${now}); }
    });
  });
  return "1";
})()`;
const seenAt = `(async () => String(await globalThis.__seen))()`;
const edit = (id: string, status: number) => `(async () => { const t = ${now}; await globalThis.__linearlite.commands.setStatus(${JSON.stringify(id)}, ${status}); return String(t); })()`;
/** The clean issue at `offset` in the default list order, read from the replica, not from what the page holds. */
const pickIssue = (offset: number) =>
  `(async () => { const { docs } = await ${issueDocs}.query({ index: "byModified", eq: [false], reverse: true, limit: ${offset + 200} }); const r = docs.filter((i) => !i.dirty)[${offset}]; return JSON.stringify({ id: r.id, status: r.status }); })()`;
const dirtyIn = (ids: readonly string[], stream = "issues") =>
  `(async () => JSON.stringify((await globalThis.__linearlite.store.docs.collection(${JSON.stringify(stream)}).getMany(${JSON.stringify(ids)})).map((r) => !!r?.dirty)))()`;

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

const serverRow = async <T>(stream: string, id: string) => {
  const res = (await (await fetch(`${origin}/api/row?stream=${stream}&id=${encodeURIComponent(id)}`)).json()) as { row: T | null };
  return res.row ?? undefined;
};
const serverIssue = (id: string) => serverRow<{ status: number }>("issues", id);

const run: Record<string, () => Promise<void>> = {
  async "page-size"() {
    for (const pull of [5000, 2000, 1000, 5000, 2000, 1000, 5000, 2000, 1000]) {
      const { marks: m, heapMB } = await firstSync(pull);
      print({ scenario: "page-size", pull, ...m, heapMB });
    }
  },

  async "first-sync"() {
    const rows: Record<string, number>[] = [];
    for (let i = 0; i < RUNS; i++) {
      const { marks: m, heapMB, storageMB } = await firstSync(Number(process.env.PULL ?? 2000));
      rows.push({ ...m, heapMB, storageMB });
      print({ scenario: "first-sync", run: i, ...m, heapMB, storageMB });
    }
    for (const k of ["first-rows", "caught-up:issues", "caught-up:bodies", "caught-up:comments", "heapMB", "storageMB"]) {
      print({ scenario: "first-sync", metric: k, ...summary(rows.map((r) => r[k]!)) });
    }
  },

  /** One first sync whose profile is kept for `warm` and `ui` (`PROFILE=`). */
  async prep() {
    const { browser, marks: m, heapMB, storageMB } = await firstSync(2000, true);
    await quit(browser, true);
    print({ scenario: "prep", ...m, heapMB, storageMB, profile: browser.profile });
  },

  async warm() {
    const { profile, owned } = await syncedProfile();
    const { length: total } = await serverIssues();
    const rows: Record<string, number>[] = [];
    for (let i = 0; i < RUNS; i++) {
      const b = await warmStart("warm", profile, total);
      try {
        const m = await waitMark(b, "bench:rows-total", 60_000);
        const shown = evaluate<number>(b.session, `document.querySelectorAll(".row[data-id]").length`);
        offline(b);
        await sleep(Number(process.env.SETTLE ?? 5000));
        const { heapMB, storageMB } = evaluate<{ heapMB: number; storageMB: number }>(b.session, footprint);
        const row = { "first-rows": m["first-rows"]!, "rows-total": m["bench:rows-total"]!, heapMB, storageMB };
        rows.push(row);
        print({ scenario: "warm", origin, run: i, ...row, rows: shown, total });
      } finally {
        await quit(b, true);
      }
    }
    for (const k of ["first-rows", "rows-total", "heapMB", "storageMB"]) print({ scenario: "warm", metric: k, ...summary(rows.map((r) => r[k]!)) });
    if (owned) rmSync(profile, { recursive: true, force: true });
  },

  async ui() {
    const { profile, owned } = await syncedProfile();
    const truth = truthOf(await serverIssues());
    const script = readFileSync(new URL("./ui-latency.js", import.meta.url), "utf8").replace("__TRUTH__", JSON.stringify(truth));
    const b = await warmStart("ui", profile, truth.total);
    try {
      await waitMark(b, "bench:rows-total", 60_000);
      offline(b);
      await sleep(3000);
      evaluate(b.session, `(() => { globalThis.__ui = undefined; ${script.trim()}.then((r) => (globalThis.__ui = r), (e) => (globalThis.__ui = JSON.stringify({ error: String(e?.stack ?? e) }))); return "started"; })()`);
      const out = await waitFor("ui-latency.js", () => evaluate<Record<string, unknown> | "">(b.session, `globalThis.__ui ?? ""`) || undefined, 900_000);
      const { heapMB } = evaluate<{ heapMB: number }>(b.session, footprint);
      print({ scenario: "ui", origin, ...out, heapMBAfter: heapMB });
    } finally {
      await quit(b, true);
      if (owned) rmSync(profile, { recursive: true, force: true });
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

  async tabs() {
    const { browser: b } = await firstSync(2000, true);
    const A = `${b.session}@t1`;
    const B = `${b.session}@t2`;
    ab(b.session, "tab", "new", `${origin}/issues`);
    await waitFor("tab B rows", () => (evaluate<number>(B, `document.querySelectorAll(".row[data-id]").length`) > 0 ? true : undefined));
    print({ scenario: "tabs", leaderA: "leader" in evaluate<Record<string, number>>(A, marks), leaderB: "leader" in evaluate<Record<string, number>>(B, marks) });
    const read = (s: string) => Number(evaluate<string>(s, seenAt));
    print({ scenario: "tabs", metric: "A->B", ...summary(crossEdits(A, B, 10, read)) });
    print({ scenario: "tabs", metric: "B->A", ...summary(crossEdits(B, A, 10, read)) });

    ab(A, "set", "offline", "on");
    const { id, status } = evaluate<{ id: string; status: number }>(B, pickIssue(500));
    const next = (status + 1) % 5;
    evaluate(B, edit(id, next));
    await sleep(3000);
    const [pending] = evaluate<boolean[]>(B, dirtyIn([id]));
    const serverBefore = (await serverIssue(id))?.status;
    const tClose = Date.now();
    const port = new URL(ab(b.session, "get", "cdp-url")).port;
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { id: string; url: string }[];
    const leader = targets.find((t) => t.url.includes("pull=2000"));
    if (!leader) throw new Error("no leader tab");
    await fetch(`http://127.0.0.1:${port}/json/close/${leader.id}`);
    ab(b.session, "tab", "t2");
    await waitFor("B to lead", () => ("leader" in evaluate<Record<string, number>>(B, marks) ? true : undefined), 30_000);
    await waitFor("B to push", () => (evaluate<boolean[]>(B, dirtyIn([id]))[0] ? undefined : true), 30_000);
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
    const ids = edits.map((e) => e.id);
    const issue = ids[0]!;
    const note = `written offline ${Date.now()}`;
    const comment = evaluate<string>(
      b.session,
      `(async () => { const { commands } = globalThis.__linearlite; await commands.setDescription(${JSON.stringify(issue)}, ${JSON.stringify(note)}); return commands.addComment(${JSON.stringify(issue)}, ${JSON.stringify(note)}); })()`,
    );
    const unsent = () => [...evaluate<boolean[]>(b.session, dirtyIn(ids)), ...evaluate<boolean[]>(b.session, dirtyIn([issue], "bodies")), ...evaluate<boolean[]>(b.session, dirtyIn([comment], "comments"))];
    await sleep(4000);
    const dirtyOffline = unsent();
    const statusOffline = evaluate<string>(b.session, `document.querySelector(".sync").textContent`);
    const serverOffline = await Promise.all(edits.map((e) => serverIssue(e.id).then((r) => r?.status)));
    const t0 = Date.now();
    ab(b.session, "set", "offline", "off");
    await waitFor("acks", () => (unsent().some(Boolean) ? undefined : true));
    const ackMs = Date.now() - t0;
    const serverOnline = await Promise.all(edits.map((e) => serverIssue(e.id).then((r) => r?.status)));
    const descriptionOnline = (await serverRow<{ description: string }>("bodies", issue))?.description === note;
    const commentOnline = (await serverRow<{ body: string }>("comments", comment))?.body === note;
    print({
      scenario: "offline",
      expected: edits.map((e) => e.next),
      dirtyOffline,
      statusOffline,
      serverOffline,
      reconnectToAckedMs: ackMs,
      serverOnline,
      descriptionOnline,
      commentOnline,
      statusOnline: evaluate<string>(b.session, `document.querySelector(".sync").textContent`),
    });
    await quit(b);
  },

  /** Jumps to rows 5,000 and 50,000 and back, then the rows TanStack holds and the heap. */
  jump: () => deepScroll("jump"),
  /** Steps and flings around row 50,000, checking each row shown against the replica's order. */
  scroll: () => deepScroll("scroll"),
  /** Edits above, inside and below a window at row 50,000; frames until the rows shown are right again. */
  live: () => deepScroll("live"),
};

/** Runs `bench/deep-scroll.js` in a warm page. `live` edits issues, so it runs on a copy of the profile. */
async function deepScroll(mode: "jump" | "scroll" | "live"): Promise<void> {
  const { profile: synced, owned } = await syncedProfile();
  const profile = mode === "live" ? mkdtempSync(join(tmpdir(), "linearlite-live-")) : synced;
  if (mode === "live") cpSync(synced, profile, { recursive: true });
  const { total, jumps } = truthOf(await serverIssues());
  const script = readFileSync(new URL("./deep-scroll.js", import.meta.url), "utf8").replace("__TRUTH__", JSON.stringify({ mode, total, jumps }));
  const b = await warmStart(mode, profile, total);
  try {
    await waitMark(b, "bench:rows-total", 60_000);
    offline(b);
    await sleep(3000);
    evaluate(b.session, `(() => { globalThis.__ui = undefined; ${script.trim()}.then((r) => (globalThis.__ui = r), (e) => (globalThis.__ui = JSON.stringify({ error: String(e?.stack ?? e) }))); return "started"; })()`);
    const out = await waitFor("deep-scroll.js", () => evaluate<Record<string, unknown> | "">(b.session, `globalThis.__ui ?? ""`) || undefined, 900_000);
    const { heapMB } = evaluate<{ heapMB: number }>(b.session, footprint);
    print({ scenario: mode, origin, ...out, heapMBAfter: heapMB });
  } finally {
    await quit(b, true);
    if (mode === "live") rmSync(profile, { recursive: true, force: true });
    if (owned) rmSync(synced, { recursive: true, force: true });
  }
}

for (const name of scenarios) {
  const go = run[name];
  if (!go) throw new Error(`unknown scenario ${name}; one of ${Object.keys(run).join(", ")}`);
  await go();
}

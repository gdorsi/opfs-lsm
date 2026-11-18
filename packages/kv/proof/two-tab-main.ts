/**
 * Tab A puts, warms SST readers, and must still get the key after tab B ingests.
 * Then tab A range-deletes rows, some flushed and some not, and tab B must
 * read them as absent before and after it ingests. Last, both tabs open a
 * second database name next to the first: the same keys hold different values
 * in each, and destroying the second leaves the first intact.
 *
 *   ?auto=1&role=a     leader tab
 *   ?auto=1&role=b     peer tab
 *   ?local=1           one page, two handles, one EngineHost
 *   ?nobc=1            drop BroadcastChannel messages before openDb
 *   ?scenario=pressure databases over maxBytes, with a handler in each tab and with none
 *   ?scenario=quota    maxBytes "quota" over a quota the script overrides: what one answer does to the usage estimate
 *   ?scenario=destroy  destroyDb with other tabs open: one live, one crashed, one frozen, one navigated away
 *   ?role=holder&tag=t&db=name  a tab that holds `name` open for the destroy scenario, read through DevTools
 */
const params = new URLSearchParams(location.search);
const ROLE = params.get("role");
const LOCAL = params.has("local");
const NOBC = params.has("nobc");
const AUTO = params.has("auto");
const DB_NAME = params.get("name") ?? "two-tab";
const PRESSURE = params.get("scenario") === "pressure";
const QUOTA = params.get("scenario") === "quota";
const DESTROY = params.get("scenario") === "destroy";

const statusEl = document.getElementById("status")!;
const out = document.getElementById("out")!;
const runBtn = document.getElementById("run") as HTMLButtonElement;

let bcPosts = 0;

if (NOBC) {
  class SilentChannel {
    constructor(_name: string) {}
    postMessage(_data: unknown): void {
      bcPosts += 1;
    }
    addEventListener(): void {}
    removeEventListener(): void {}
    close(): void {}
  }
  Object.defineProperty(globalThis, "BroadcastChannel", {
    configurable: true,
    writable: true,
    value: SilentChannel,
  });
}

const maxWalBytes = 1 << 30;
const enc = new TextEncoder();
const dec = new TextDecoder();

type Handle = {
  put(key: Uint8Array, value: Uint8Array): Promise<unknown>;
  batch(
    body: (tx: {
      put(key: Uint8Array, value: Uint8Array): void;
      deleteRange(bounds: { start?: Uint8Array; endExclusive?: Uint8Array }): void;
    }) => void,
  ): Promise<unknown>;
  get(key: Uint8Array): Promise<Uint8Array | undefined>;
  ingest(): Promise<{ generation: number }>;
  range(): AsyncIterable<{ key: Uint8Array; value: Uint8Array }>;
  view<T>(
    body: (snap: {
      get(key: Uint8Array): Promise<Uint8Array | undefined>;
    }) => Promise<T>,
  ): Promise<T>;
  sync(): Promise<void>;
  close(): Promise<void>;
  dangerousDestroy(): Promise<void>;
};

type Rows = [string, string][];

/** What tab B does for tab A. `name` picks a database; none means the first. */
type OtherTab = {
  put(key: string, value: string, name?: string): Promise<void>;
  get(key: string, name?: string): Promise<string | null>;
  ingest(name?: string): Promise<number>;
  /** Every row of `name`, after a `sync`. Opens `name` in that tab when it is not open yet. */
  rows(name: string): Promise<Rows>;
  destroy(name: string): Promise<void>;
  cap(name: string, mode: CapMode): Promise<CapReport>;
};

type PeerCmd =
  | { id: number; op: "put"; key: string; value: string; name?: string }
  | { id: number; op: "get"; key: string; name?: string }
  | { id: number; op: "ingest"; name?: string }
  | { id: number; op: "rows"; name: string }
  | { id: number; op: "destroy"; name: string }
  | { id: number; op: "cap"; key: string; value: CapMode };

/** A handle opened with maxBytes, with a handler that range-deletes the oldest rows or with none. */
type CapMode = "oldest" | "none";
type CapReport = { calls: number; deleted: number; warns: number; rows: number; bytes: number };

const CAP = 1024 * 1024;
const CAP_ROWS = 160;
const capped = new Map<string, { db: import("../dist/index.js").Db; report: CapReport }>();

const warn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  for (const [name, { report }] of capped) if (String(args[0]).includes(`${name} must free`)) report.warns += 1;
  warn(...args);
};

/** Opens `name` in this tab on the first call, then reports what this tab sees. */
async function cap(name: string, mode: CapMode): Promise<CapReport> {
  const testing = await import("../dist/testing.js");
  let entry = capped.get(name);
  if (!entry) {
    const db = await testing.openHarnessDb({ name, maxBytes: CAP, maxWalBytes });
    const report = { calls: 0, deleted: 0, warns: 0, rows: 0, bytes: 0 };
    entry = { db, report };
    capped.set(name, entry);
    if (mode === "oldest") {
      db.onPressure(async ({ need }) => {
        report.calls += 1;
        for await (const { key, value } of db.range()) {
          if (need <= 0) return void (await db.batch((tx) => tx.deleteRange({ endExclusive: key })));
          need -= key.byteLength + value.byteLength;
          report.deleted += 1;
        }
      });
    }
  }
  await entry.db.sync();
  entry.report.rows = 0;
  for await (const _ of entry.db.range()) entry.report.rows += 1;
  entry.report.bytes = await sstBytes(entry.db);
  return { ...entry.report };
}

type Db = import("../dist/index.js").Db;

async function sstBytes(db: Db): Promise<number> {
  return (await (await import("../dist/testing.js")).readStats(db)).host.layout.reduce((n, l) => n + l.bytes, 0);
}

async function fillPastCap(db: Db): Promise<void> {
  const testing = await import("../dist/testing.js");
  for (let i = 0; i < CAP_ROWS; i += 16) {
    await db.batch((tx) => {
      for (let j = i; j < i + 16; j++) {
        tx.put(enc.encode(`r${String(j).padStart(5, "0")}`), crypto.getRandomValues(new Uint8Array(16 * 1024)));
      }
    });
  }
  await testing.ingest(db);
}

/** Waits for `cond`, then a while more so a second offer would have come. */
async function poll(cond: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 100 && !(await cond()); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  must(await cond(), `timed out waiting for ${what}`);
  await new Promise((resolve) => setTimeout(resolve, 1500));
}

/**
 * Over maxBytes with a handler in each tab: one tab answers once, and both
 * read what it left, under the cap. With no handler: each tab warns once.
 */
async function pressureScenario(other: OtherTab): Promise<void> {
  log(`mode=${modeLabel()}`);
  const name = `${DB_NAME}-cap`;
  await cap(name, "oldest");
  await other.cap(name, "oldest");
  await fillPastCap(capped.get(name)!.db);
  await poll(async () => (await cap(name, "oldest")).calls + (await other.cap(name, "oldest")).calls > 0, "an answer");
  await (await import("../dist/testing.js")).settle(capped.get(name)!.db);
  const [a, b] = [await cap(name, "oldest"), await other.cap(name, "oldest")];
  must(a.calls + b.calls === 1, `handlers ran ${a.calls} times in tab A and ${b.calls} in tab B`);
  const left = CAP_ROWS - a.deleted - b.deleted;
  must(a.rows === left && b.rows === left, `tabs read ${a.rows} and ${b.rows} rows, expected ${left}`);
  must(a.bytes <= CAP && a.warns + b.warns === 0, `${a.bytes} bytes left, ${a.warns + b.warns} warnings`);
  log(`pressure answered by tab ${a.calls === 1 ? "A" : "B"}, ${a.bytes} bytes left`);
  log(`both tabs read ${left} of ${CAP_ROWS} rows`);

  const bare = `${DB_NAME}-nohandler`;
  await cap(bare, "none");
  await other.cap(bare, "none");
  await fillPastCap(capped.get(bare)!.db);
  await poll(async () => (await cap(bare, "none")).warns > 0 && (await other.cap(bare, "none")).warns > 0, "warnings");
  const [c, d] = [await cap(bare, "none"), await other.cap(bare, "none")];
  must(c.warns === 1 && d.warns === 1, `warnings: tab A ${c.warns}, tab B ${d.warns}`);
  must(c.rows === CAP_ROWS && d.rows === CAP_ROWS, "a row went missing with no handler");
  log("no handler: one warning in each tab");
  log("pressure ok");
}

/**
 * Fills a database, then has the script cut the origin's quota to just under
 * the usage. A handle opened with maxBytes "quota" gets an offer and range
 * deletes the oldest rows. Prints usage and SST bytes from the handler on,
 * and how often the handler ran.
 */
async function quotaScenario(): Promise<void> {
  log(`mode=${modeLabel()}`);
  const testing = await import("../dist/testing.js");
  const name = `${DB_NAME}-quota`;
  const filler = await testing.openHarnessDb({ name, maxWalBytes });
  await fillPastCap(filler);
  await testing.settle(filler);
  const usage = async () => (await navigator.storage.estimate()).usage!;
  const before = await usage();
  const quota = Math.floor(before / 0.93);
  const set = await fetch(`/quota?size=${quota}`, { method: "POST" });
  must(set.ok, `the quota override failed: ${(await set.json()).error}`);
  log(`usage ${before}, quota of the SharedWorker's estimate set to ${quota}`);

  const db = await testing.openHarnessDb({ name, maxBytes: "quota", maxWalBytes });
  let t0 = 0;
  let calls = 0;
  let answered = 0;
  let last = before;
  let lastSst = 0;
  /** Logs the usage and SST bytes now; a poll logs only when one moved. */
  const snap = async (what: string, poll = false) => {
    const [u, sst] = [await usage(), await sstBytes(db)];
    if (poll && u === last && sst === lastSst) return;
    [last, lastSst] = [u, sst];
    log(`+${Math.round(performance.now() - t0)} ms ${what}: usage ${u}, sst ${sst}`);
  };
  db.onPressure(async (p) => {
    t0 ||= performance.now();
    calls += 1;
    await snap(`handler ${calls} starts, offer ${JSON.stringify(p)}`);
    let need = p.need;
    let end: Uint8Array | undefined;
    for await (const { key, value } of db.range()) {
      if (need <= 0) {
        end = key;
        break;
      }
      need -= key.byteLength + value.byteLength;
    }
    await db.batch((tx) => tx.deleteRange(end ? { endExclusive: end } : {}));
    answered += 1;
  });
  for (let i = 0; i < 100 && !calls; i++) await new Promise((resolve) => setTimeout(resolve, 100));
  must(calls, "no offer came");
  let flushed = 0;
  for (const end = performance.now() + 10_000; performance.now() < end; ) {
    if (answered !== flushed) {
      flushed = answered;
      await snap("handler resolved");
      await testing.ingest(db);
      await snap("flushed");
      await testing.settle(db);
      await snap("settled");
    } else await snap("poll", true);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  log(`unchanged until +${Math.round(performance.now() - t0)} ms, handler calls: ${calls}`);
  must(calls === 1, `the handler ran ${calls} times for one answer`);
  must(last < before, `usage went from ${before} to ${last}`);
  log("quota ok");
}

/** Rows over several 32 KB pages, so a read late in the range misses the page cache. */
const DESTROY_ROWS = 2000;
const rowKey = (i: number) => enc.encode(`r${String(i).padStart(5, "0")}`);

async function fillRows(db: Db): Promise<void> {
  for (let i = 0; i < DESTROY_ROWS; i += 250) {
    await db.batch((tx) => {
      for (let j = i; j < i + 250; j++) tx.put(rowKey(j), crypto.getRandomValues(new Uint8Array(100)));
    });
  }
}

/**
 * A tab that holds `db` open, with rows flushed and a WAL tail. The destroy
 * scenario reads `window.holder` through DevTools.
 */
async function holder(): Promise<void> {
  // A reload of this page, after a crash, a discard or an eviction, must not open the database again.
  if (sessionStorage.getItem("held")) {
    Object.assign(globalThis, { holder: { state: () => ({ closed: null, restored: false, reloaded: true }) } });
    return;
  }
  sessionStorage.setItem("held", "1");
  const testing = await import("../dist/testing.js");
  const db = await testing.openHarnessDb({ name: params.get("db")!, maxWalBytes });
  let closed: string | null = null;
  let restored = false;
  db.changes((e) => {
    if (e.kind === "closed") closed = e.reason;
  });
  addEventListener("pageshow", (e) => {
    if (e.persisted) restored = true;
  });
  await fillRows(db);
  await testing.ingest(db);
  await db.put(enc.encode("tail"), enc.encode("t"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let viewed: Promise<string> | undefined;
  const errorName = (err: unknown) => (err instanceof Error ? err.name : String(err));
  Object.assign(globalThis, {
    holder: {
      state: () => ({ closed, restored, reloaded: false }),
      /** A view that reads the first row, then waits, then reads the last one, which is on another page. */
      async startView() {
        let started!: () => void;
        const first = new Promise<void>((resolve) => (started = resolve));
        viewed = db
          .view(async (snap) => {
            must((await snap.get(rowKey(0))) !== undefined, "the view missed the first row");
            started();
            await gate;
            return (await snap.get(rowKey(DESTROY_ROWS - 1))) === undefined ? "read nothing" : "read the old row";
          })
          .catch(errorName);
        await first;
        return "started";
      },
      async after() {
        release();
        const view = await viewed;
        const put = await db.put(enc.encode("late"), enc.encode("x")).then(() => "resolved", errorName);
        return { closed, view, put };
      },
    },
  });
  await fetch(`/signal?what=${params.get("tag")}`, { method: "POST" });
}

/** Asks the script to drive the tab `tag` through DevTools. */
async function devtools<T = unknown>(op: string, tag: string, extra: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`/cdp?${new URLSearchParams({ op, tag, ...extra })}`, { method: "POST" });
  const body = (await res.json()) as { value?: T; error?: string };
  if (!res.ok || body.error) throw new Error(`${op} ${tag}: ${body.error ?? res.status}`);
  return body.value as T;
}

async function openHolder(tag: string, db: string): Promise<void> {
  await devtools("open", tag, { db });
}

const walName = (name: string) => `opfs-lsm-wal/${name}`;
const listed = async (idbName: string) => (await indexedDB.databases()).some((d) => d.name === idbName);

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** The head and the highest manifest number of an existing WAL database. */
async function walFloor(name: string): Promise<{ head: number; top: number }> {
  const idb = await idbRequest(indexedDB.open(walName(name)));
  try {
    const tx = idb.transaction(["wal", "meta"]);
    const keys = (await idbRequest(tx.objectStore("wal").getAllKeys())) as number[];
    const meta = tx.objectStore("meta");
    const num = async (key: string) => ((await idbRequest(meta.get(key))) as number | undefined) ?? 0;
    const [ingested, generation, top] = [await num("ingestedThrough"), await num("generation"), await num("topGeneration")];
    return { head: Math.max(ingested, ...keys), top: Math.max(generation, top) };
  } finally {
    idb.close();
  }
}

async function folderExists(name: string): Promise<boolean> {
  try {
    const lsm = await (await navigator.storage.getDirectory()).getDirectoryHandle("opfs-lsm");
    await lsm.getDirectoryHandle(name);
    return true;
  } catch (err) {
    if (err instanceof DOMException && err.name === "NotFoundError") return false;
    throw err;
  }
}

async function destroyedRow(name: string): Promise<unknown> {
  if (!(await listed("opfs-lsm-destroyed"))) return undefined;
  const idb = await idbRequest(indexedDB.open("opfs-lsm-destroyed"));
  try {
    return await idbRequest(idb.transaction("destroyed").objectStore("destroyed").get(name));
  } finally {
    idb.close();
  }
}

async function leftNothing(name: string): Promise<boolean> {
  return !(await listed(walName(name))) && !(await folderExists(name));
}

const sleep = (ms: number) => new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms));

/** `destroyDb` while the tab `tag` holds `name` and DevTools has `away` it: how long it waits, and what the tab saw. */
async function destroyPast(mod: typeof import("../dist/index.js"), tag: string, name: string, away: string, back: string, what: string): Promise<void> {
  await openHolder(tag, name);
  await devtools(away, tag);
  const t0 = performance.now();
  const done = mod.destroyDb(name).then(() => performance.now());
  const end = await Promise.race([done, sleep(10_000)]);
  if (end !== undefined) {
    log(`${what}: destroyDb finished in ${Math.round(end - t0)} ms`);
    await devtools(back, tag);
  } else {
    const t1 = performance.now();
    await devtools(back, tag);
    const late = await Promise.race([done, sleep(20_000)]);
    must(late !== undefined, `${what}: destroyDb still waits 20 s after ${back}`);
    log(`${what}: destroyDb waited 10 s, then finished ${Math.round(late - t1)} ms after ${back}`);
  }
  const seen = await devtools<{ closed: string | null; restored: boolean; reloaded: boolean } | null>("eval", tag, {
    expr: "globalThis.holder ? holder.state() : null",
  });
  const reasons = await devtools<string[]>("notRestored", tag);
  const page = !seen ? "has no page" : seen.reloaded ? "reloaded its page" : `kept its page, restored=${seen.restored}, closed reason=${seen.closed}`;
  log(`${what}: the tab ${page}${reasons.length > 0 ? `; not restored from the back/forward cache: ${reasons.join(", ")}` : ""}`);
  must(await leftNothing(name), `${what}: destroyDb left a store behind`);
}

/**
 * destroyDb from this tab while tab b holds the database with a view open:
 * every handle closes, both stores go, and the next open starts past them.
 * Then a name never opened, a crashed tab, a frozen tab and a tab in the
 * back/forward cache.
 */
async function destroyScenario(): Promise<void> {
  log(`mode=${modeLabel()}`);
  const mod = await import("../dist/index.js");
  const testing = await import("../dist/testing.js");
  const name = `${DB_NAME}-destroy`;
  const db = await testing.openHarnessDb({ name, maxWalBytes });
  let ownClosed: string | null = null;
  db.changes((e) => {
    if (e.kind === "closed") ownClosed = e.reason;
  });
  await fillRows(db);
  await testing.ingest(db);
  await db.put(enc.encode("tail"), enc.encode("t"));
  await openHolder("b", name);
  must((await devtools("eval", "b", { expr: "holder.startView()" })) === "started", "tab b did not start its view");
  const old = await walFloor(name);

  const t0 = performance.now();
  await mod.destroyDb(name);
  log(`destroyDb with two tabs open: ${Math.round(performance.now() - t0)} ms`);
  const b = await devtools<{ closed: string | null; view: string; put: string }>("eval", "b", { expr: "holder.after()" });
  must(b.closed === "destroyed" && ownClosed === "destroyed", `closed reasons: other tab ${b.closed}, this tab ${ownClosed}`);
  log("other tab closed reason=destroyed");
  must(b.put === "ClosedError" && b.view === "ClosedError", `other tab: put ${b.put}, view read ${b.view}`);
  log("other tab put and view read rejected with ClosedError");
  must(!(await listed(walName(name))), "the WAL database is still listed");
  log("wal database gone");
  must(!(await folderExists(name)), "the folder is still in OPFS");
  log("folder gone");

  const again = await testing.openHarnessDb({ name, maxWalBytes });
  let rows = 0;
  for await (const _ of again.range()) rows += 1;
  must(rows === 0, `the reopened database reads ${rows} rows`);
  const seq = await again.put(enc.encode("new"), enc.encode("n"));
  const { generation } = await testing.ingest(again);
  must(seq > old.head && generation > old.top, `seq ${seq} after head ${old.head}, manifest ${generation} after top ${old.top}`);
  must(text(await again.get(enc.encode("new"))) === "n", "the write after the reopen did not read back");
  await again.close();
  log(`reopened empty: seq ${seq} past the old head ${old.head}, manifest ${generation} past the old top ${old.top}`);

  const never = `${DB_NAME}-never`;
  await mod.destroyDb(never);
  must((await leftNothing(never)) && (await destroyedRow(never)) === undefined, "destroyDb made a store for a name never opened");
  log("never-opened left nothing");

  const crashed = `${DB_NAME}-crashed`;
  await openHolder("c", crashed);
  await devtools("crash", "c");
  const t1 = performance.now();
  const end = await Promise.race([mod.destroyDb(crashed).then(() => performance.now()), sleep(20_000)]);
  must(end !== undefined, "destroyDb still waits 20 s after the tab crashed");
  must(await leftNothing(crashed), "destroyDb left a store of the crashed tab");
  log(`crashed tab: destroyDb finished in ${Math.round(end - t1)} ms and left nothing`);

  await destroyPast(mod, "d", `${DB_NAME}-frozen`, "freeze", "resume", "frozen tab");
  await destroyPast(mod, "e", `${DB_NAME}-bfcache`, "away", "back", "tab navigated away");
  log("destroy ok");
}

type PeerResult = {
  id: number;
  ok: boolean;
  value: string | null;
  generation: number | null;
  error: string | null;
};

function log(line: string): void {
  out.textContent += line + "\n";
}

function text(bytes: Uint8Array | undefined): string | null {
  if (!bytes) return null;
  return dec.decode(bytes);
}

function must(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

let reported = false;

async function report(payload: { error?: string; log: string }): Promise<void> {
  if (!AUTO || reported) return;
  reported = true;
  try {
    await fetch("/two-tab-results", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("report failed", err);
  }
}

function modeLabel(): string {
  const base = LOCAL ? "local EngineHost" : "SharedWorker";
  return NOBC ? `${base} nobc` : base;
}

async function openHandle(
  mod: typeof import("../dist/index.js"),
  testing: typeof import("../dist/testing.js"),
  writerId: string,
  name: string,
  shared?: {
    folder(name: string): ReturnType<typeof testing.openBrowserFs>;
    ingest: ReturnType<typeof testing.createLocalIngestClient>;
  },
): Promise<Handle> {
  const db = await testing.openHarnessDb({
    name,
    writerId,
    maxWalBytes,
    ...(shared ? { fs: await shared.folder(name), ingest: shared.ingest } : {}),
  });
  return Object.assign(db, { ingest: () => testing.ingest(db) });
}

async function rowsOf(db: Handle): Promise<Rows> {
  await db.sync();
  const out: Rows = [];
  for await (const { key, value } of db.range()) out.push([text(key)!, text(value)!]);
  return out;
}

/** A tab's handles, one per database name, opened on first use. */
function tabOf(first: Handle, open: (name: string) => Promise<Handle>): Omit<OtherTab, "cap"> {
  const handles = new Map([[DB_NAME, first]]);
  const handle = async (name = DB_NAME) => {
    let db = handles.get(name);
    if (!db) handles.set(name, (db = await open(name)));
    return db;
  };
  return {
    async put(key, value, name) {
      await (await handle(name)).put(enc.encode(key), enc.encode(value));
    },
    async get(key, name) {
      const db = await handle(name);
      await db.sync();
      return text(await db.get(enc.encode(key)));
    },
    async ingest(name) {
      return (await (await handle(name)).ingest()).generation;
    },
    async rows(name) {
      return rowsOf(await handle(name));
    },
    async destroy(name) {
      await (await handle(name)).dangerousDestroy();
    },
  };
}

const SECOND = `${DB_NAME}-second`;
const DUPS = 8;

/** What tab A writes to `dup/<i>` of `name`, and tab B to `dup/b`. */
const dupRows = (name: string, withB: boolean): Rows => [
  ...Array.from({ length: DUPS }, (_, i): [string, string] => [`dup/${i}`, `${name}:a:${i}`]),
  ...(withB ? [["dup/b", `${name}:b`] as [string, string]] : []),
];

const dupsOf = (rows: Rows): Rows => rows.filter(([key]) => key.startsWith("dup/"));

function sameRows(what: string, got: Rows, want: Rows): void {
  must(JSON.stringify(got) === JSON.stringify(want), `${what} read ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
}

/** The paths of the files under `opfs-lsm/<name>/`. */
async function opfsFiles(name: string): Promise<string[]> {
  type Dir = FileSystemDirectoryHandle & { entries(): AsyncIterableIterator<[string, FileSystemHandle]> };
  const walk = async (dir: Dir, prefix: string): Promise<string[]> => {
    const out: string[] = [];
    for await (const [entry, handle] of dir.entries()) {
      if (handle.kind === "directory") out.push(...(await walk(handle as Dir, `${prefix}${entry}/`)));
      else out.push(prefix + entry);
    }
    return out;
  };
  const lsm = await (await navigator.storage.getDirectory()).getDirectoryHandle("opfs-lsm");
  return walk((await lsm.getDirectoryHandle(name)) as Dir, "");
}

/**
 * Opens a second database name next to the first, in both tabs. Both names
 * get the same keys with different values, and the other tab reads in each
 * only its own. Each name has its own IndexedDB database and OPFS folder.
 * Destroying the second leaves the first reading every row, in both tabs.
 */
async function twoDatabases(
  open: (name: string) => Promise<Handle>,
  first: Handle,
  other: OtherTab,
): Promise<void> {
  const second = await open(SECOND);
  sameRows(`${SECOND} in tab B on opening`, await other.rows(SECOND), []);
  log(`${SECOND} open next to ${DB_NAME} in both tabs`);

  const names = [
    [DB_NAME, first],
    [SECOND, second],
  ] as const;
  for (const [name, db] of names) {
    await db.batch((tx) => {
      for (const [key, value] of dupRows(name, false)) tx.put(enc.encode(key), enc.encode(value));
    });
    await db.ingest();
  }
  for (const [name] of names) {
    const seen = await other.rows(name);
    sameRows(`tab B in ${name}`, dupsOf(seen), dupRows(name, false));
    if (name === SECOND) must(seen.length === DUPS, `${SECOND} holds ${seen.length} rows, expected ${DUPS}`);
    else must(!seen.some(([, value]) => value.startsWith(SECOND)), `${DB_NAME} holds a row of ${SECOND}`);
  }
  log(`tab B reads only its own values in ${DB_NAME} and ${SECOND}`);

  for (const [name] of names) {
    await other.put("dup/b", `${name}:b`, name);
    await other.ingest(name);
  }
  for (const [name, db] of names) sameRows(`tab A in ${name}`, dupsOf(await rowsOf(db)), dupRows(name, true));
  log(`tab A reads only its own values in ${DB_NAME} and ${SECOND}`);

  const wals = (await indexedDB.databases()).map((db) => db.name);
  for (const [name] of names) {
    must(wals.includes(`opfs-lsm-wal/${name}`), `no IndexedDB database opfs-lsm-wal/${name} in ${wals}`);
    const files = await opfsFiles(name);
    must(files.length > 0, `opfs-lsm/${name}/ holds no files`);
    log(`opfs-lsm-wal/${name} and opfs-lsm/${name}/ (${files.length} files) exist`);
  }

  await second.dangerousDestroy();
  sameRows(`tab A in ${SECOND} after the destroy`, await rowsOf(second), []);
  sameRows(`tab B in ${SECOND} after the destroy`, await other.rows(SECOND), []);
  const kept = [await rowsOf(first), await other.rows(DB_NAME)];
  for (const rows of kept) {
    sameRows(`${DB_NAME} after the destroy`, dupsOf(rows), dupRows(DB_NAME, true));
    const byKey = new Map(rows);
    must(byKey.get("seed") === "s" && byKey.get("k") === "v" && byKey.get("after") === "yes", `${DB_NAME} lost a row`);
  }
  await other.put("dup/c", `${DB_NAME}:c`);
  await other.ingest();
  await first.sync();
  must(text(await first.get(enc.encode("dup/c"))) === `${DB_NAME}:c`, `${DB_NAME} lost a write after the destroy`);
  log(`${SECOND} destroyed, ${DB_NAME} reads its ${kept[0]!.length} rows in both tabs`);
  await second.close();
  log("two-databases ok");
}

async function scenario(self: Handle, other: OtherTab, open: (name: string) => Promise<Handle>): Promise<void> {
  const t0 = performance.now();
  log(`mode=${modeLabel()}`);
  log(
    `OPFS=${!!navigator.storage?.getDirectory}  SharedWorker=${typeof SharedWorker !== "undefined"}`,
  );

  await self.put(enc.encode("seed"), enc.encode("s"));
  const seeded = await self.ingest();
  const seed = text(await self.get(enc.encode("seed")));
  must(seed === "s", `warm get seed was ${seed}`);
  must(seeded.generation >= 1, "seed ingest did not publish a generation");
  log(`warm seed generation=${seeded.generation}`);

  await other.put("k", "v");
  await self.sync();

  const pin = await self.view(async (snap) => {
    const before = text(await snap.get(enc.encode("k")));
    const ingested = await other.ingest();
    const after = text(await snap.get(enc.encode("k")));
    return { before, after, generation: seeded.generation, ingested };
  });
  must(pin.before === "v", `pinned get before ingest was ${pin.before}`);
  must(pin.after === "v", `pinned get after ingest was ${pin.after}`);
  must(
    pin.ingested > pin.generation,
    `ingest generation ${pin.ingested} did not pass pinned ${pin.generation}`,
  );
  log(
    `pinned generation=${pin.generation} ingest generation=${pin.ingested}`,
  );

  const fresh = text(await self.get(enc.encode("k")));
  must(fresh === "v", `fresh get after ingest was ${fresh}`);
  log("fresh k=v");

  let ranged = false;
  for await (const entry of self.range()) {
    if (text(entry.key) === "k" && text(entry.value) === "v") ranged = true;
  }
  must(ranged, "range missed k after ingest");
  log("range has k");

  await self.put(enc.encode("after"), enc.encode("yes"));
  const seen = await other.get("after");
  must(seen === "yes", `other tab get after ingest was ${seen}`);
  log("other tab saw after=yes");

  await self.put(enc.encode("gone/1"), enc.encode("x"));
  await self.ingest();
  await self.put(enc.encode("gone/2"), enc.encode("x"));
  await self.put(enc.encode("gone0"), enc.encode("kept"));
  must((await other.get("gone/1")) === "x", "other tab missed gone/1 before the range delete");
  await self.batch((tx) =>
    tx.deleteRange({ start: enc.encode("gone/"), endExclusive: enc.encode("gone0") }),
  );
  for (const key of ["gone/1", "gone/2"]) {
    const got = await other.get(key);
    must(got === null, `other tab read ${key}=${got} after the range delete`);
  }
  must((await other.get("gone0")) === "kept", "range delete reached past its end");
  await other.ingest();
  const flushed = await other.get("gone/1");
  must(flushed === null, `other tab read gone/1=${flushed} after ingesting the range delete`);
  log("other tab saw gone/1 and gone/2 absent after the range delete");

  await twoDatabases(open, self, other);

  if (NOBC) {
    must(bcPosts > 0, "BroadcastChannel replacement was not used");
    log(`bc_posts=${bcPosts}`);
  }
  log(`scenario_ms=${Math.round(performance.now() - t0)}`);
  log("two-tab ok");
}

function parseCmd(value: unknown): PeerCmd | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as { id?: unknown; op?: unknown; key?: unknown; value?: unknown; name?: unknown };
  if (typeof rec.id !== "number") return null;
  const name = typeof rec.name === "string" ? { name: rec.name } : {};
  if (rec.op === "ingest") return { id: rec.id, op: "ingest", ...name };
  if ((rec.op === "rows" || rec.op === "destroy") && typeof rec.name === "string") {
    return { id: rec.id, op: rec.op, name: rec.name };
  }
  if (rec.op === "cap" && typeof rec.key === "string" && (rec.value === "oldest" || rec.value === "none")) {
    return { id: rec.id, op: "cap", key: rec.key, value: rec.value };
  }
  if (rec.op === "get" && typeof rec.key === "string") {
    return { id: rec.id, op: "get", key: rec.key, ...name };
  }
  if (
    rec.op === "put" &&
    typeof rec.key === "string" &&
    typeof rec.value === "string"
  ) {
    return { id: rec.id, op: "put", key: rec.key, value: rec.value, ...name };
  }
  return null;
}

async function postResult(result: PeerResult): Promise<void> {
  const res = await fetch("/peer/result", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(result),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`peer result ${res.status}`);
  }
}

async function servePeer(tab: Omit<OtherTab, "cap">): Promise<void> {
  for (;;) {
    const res = await fetch("/peer/next");
    if (!res.ok) throw new Error(`peer next ${res.status}`);
    const cmd = parseCmd(await res.json());
    if (!cmd) throw new Error("bad peer command");
    try {
      switch (cmd.op) {
        case "put":
          await tab.put(cmd.key, cmd.value, cmd.name);
          await postResult({
            id: cmd.id,
            ok: true,
            value: null,
            generation: null,
            error: null,
          });
          break;
        case "get": {
          const got = await tab.get(cmd.key, cmd.name);
          await postResult({
            id: cmd.id,
            ok: true,
            value: got,
            generation: null,
            error: null,
          });
          break;
        }
        case "ingest": {
          const generation = await tab.ingest(cmd.name);
          await postResult({
            id: cmd.id,
            ok: true,
            value: null,
            generation,
            error: null,
          });
          break;
        }
        case "rows": {
          const value = JSON.stringify(await tab.rows(cmd.name));
          await postResult({ id: cmd.id, ok: true, value, generation: null, error: null });
          break;
        }
        case "destroy":
          await tab.destroy(cmd.name);
          await postResult({ id: cmd.id, ok: true, value: null, generation: null, error: null });
          break;
        case "cap": {
          const value = JSON.stringify(await cap(cmd.key, cmd.value));
          await postResult({ id: cmd.id, ok: true, value, generation: null, error: null });
          break;
        }
        default: {
          const _exhaustive: never = cmd;
          void _exhaustive;
        }
      }
    } catch (err) {
      await postResult({
        id: cmd.id,
        ok: false,
        value: null,
        generation: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function remoteOther(): Promise<OtherTab> {
  const ready = await fetch("/peer/ready");
  if (!ready.ok) throw new Error("tab B did not connect");
  return {
    async put(key, value, name) {
      await callPeer({ op: "put", key, value, name });
    },
    async get(key, name) {
      const result = await callPeer({ op: "get", key, name });
      return result.value;
    },
    async ingest(name) {
      const result = await callPeer({ op: "ingest", name });
      must(typeof result.generation === "number", "ingest missing generation");
      return result.generation;
    },
    async rows(name) {
      return JSON.parse((await callPeer({ op: "rows", name })).value!) as Rows;
    },
    async destroy(name) {
      await callPeer({ op: "destroy", name });
    },
    async cap(name, mode) {
      return JSON.parse((await callPeer({ op: "cap", key: name, value: mode })).value!) as CapReport;
    },
  };
}

async function callPeer(cmd: {
  op: PeerCmd["op"];
  key?: string;
  value?: string;
  name?: string | undefined;
}): Promise<PeerResult> {
  const res = await fetch("/peer/call", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const body = (await res.json()) as PeerResult;
  if (!res.ok || !body.ok) {
    throw new Error(body.error ?? `peer call ${res.status}`);
  }
  return body;
}

async function run(): Promise<void> {
  statusEl.textContent = "running";
  out.textContent = "";
  const mod = await import("../dist/index.js");
  const testing = await import("../dist/testing.js");
  if (LOCAL) {
    const folders = new Map<string, ReturnType<typeof testing.openBrowserFs>>();
    const folder = (name: string) => {
      let fs = folders.get(name);
      if (!fs) folders.set(name, (fs = testing.openBrowserFs(name)));
      return fs;
    };
    // As the SharedWorker does: the host looks up the folder per operation and never creates it.
    const host = new testing.EngineHost((name) => testing.findBrowserFs(name));
    const shared = { folder, ingest: testing.createLocalIngestClient(host) };
    const open = (writerId: string) => (name: string) => openHandle(mod, testing, writerId, name, shared);
    const openA = open("tab-a");
    const openB = open("tab-b");
    const self = await openA(DB_NAME);
    const otherDb = await openB(DB_NAME);
    const other: OtherTab = {
      ...tabOf(otherDb, openB),
      cap: () => Promise.reject(new Error("the pressure scenario needs two tabs")),
    };
    await scenario(self, other, openA);
    await self.close();
    await otherDb.close();
    return;
  }

  if (ROLE === "b") {
    const open = (name: string) => openHandle(mod, testing, "tab-b", name);
    const db = await open(DB_NAME);
    log("mode=" + modeLabel());
    log("tab B ready");
    const ready = await fetch("/peer/ready", { method: "POST" });
    if (!ready.ok) throw new Error("ready rejected");
    await servePeer(tabOf(db, open));
    return;
  }

  if (DESTROY) return destroyScenario();
  const open = (name: string) => openHandle(mod, testing, "tab-a", name);
  const db = await open(DB_NAME);
  if (QUOTA) await quotaScenario();
  else if (PRESSURE) await pressureScenario(await remoteOther());
  else await scenario(db, await remoteOther(), open);
  await db.close();
}

async function finish(): Promise<void> {
  let failed: string | undefined;
  try {
    await run();
  } catch (err) {
    const e = err as Error;
    failed = String(e?.stack || err);
    log(failed);
  }
  statusEl.textContent = "idle";
  runBtn.disabled = false;
  if (ROLE === "b" && !failed) return;
  if (failed) await report({ error: failed, log: out.textContent });
  else await report({ log: out.textContent });
}

runBtn.addEventListener("click", () => {
  runBtn.disabled = true;
  void finish();
});

if (ROLE === "holder") {
  holder().catch((err) => log(String(err?.stack ?? err)));
} else if (AUTO) {
  runBtn.disabled = true;
  void finish();
}

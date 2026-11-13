/**
 * Tab A puts, warms SST readers, and must still get the key after tab B ingests.
 * Then tab A range-deletes rows, some flushed and some not, and tab B must
 * read them as absent before and after it ingests.
 *
 *   ?auto=1&role=a     leader tab
 *   ?auto=1&role=b     peer tab
 *   ?local=1           one page, two handles, one EngineHost
 *   ?nobc=1            drop BroadcastChannel messages before openDb
 *   ?scenario=pressure databases over maxBytes, with a handler in each tab and with none
 *   ?scenario=quota    maxBytes "quota" over a quota the script overrides: what one answer does to the usage estimate
 */
const params = new URLSearchParams(location.search);
const ROLE = params.get("role");
const LOCAL = params.has("local");
const NOBC = params.has("nobc");
const AUTO = params.has("auto");
const DB_NAME = params.get("name") ?? "two-tab";
const PRESSURE = params.get("scenario") === "pressure";
const QUOTA = params.get("scenario") === "quota";

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
};

type OtherTab = {
  put(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  ingest(): Promise<number>;
  cap(name: string, mode: CapMode): Promise<CapReport>;
};

type PeerCmd =
  | { id: number; op: "put"; key: string; value: string }
  | { id: number; op: "get"; key: string }
  | { id: number; op: "ingest" }
  | { id: number; op: "cap"; key: string; value: CapMode };

/** A handle opened with maxBytes, with a handler that range-deletes the oldest rows or with none. */
type CapMode = "oldest" | "none";
type CapReport = { calls: number; deleted: number; warns: number; rows: number; bytes: number };

const CAP = 1024 * 1024;
const CAP_ROWS = 160;
const capped = new Map<string, { db: import("../dist/index.js").Db; report: CapReport }>();

const warn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  for (const [name, { report }] of capped) if (String(args[0]).includes(`${name} holds`)) report.warns += 1;
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
  shared?: {
    fs: Awaited<ReturnType<typeof testing.openBrowserFs>>;
    ingest: ReturnType<typeof testing.createLocalIngestClient>;
  },
): Promise<Handle> {
  const db = await testing.openHarnessDb({
    name: DB_NAME,
    writerId,
    maxWalBytes,
    ...(shared ? { fs: shared.fs, ingest: shared.ingest } : {}),
  });
  return Object.assign(db, { ingest: () => testing.ingest(db) });
}

async function scenario(self: Handle, other: OtherTab): Promise<void> {
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

  if (NOBC) {
    must(bcPosts > 0, "BroadcastChannel replacement was not used");
    log(`bc_posts=${bcPosts}`);
  }
  log(`scenario_ms=${Math.round(performance.now() - t0)}`);
  log("two-tab ok");
}

function parseCmd(value: unknown): PeerCmd | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as { id?: unknown; op?: unknown; key?: unknown; value?: unknown };
  if (typeof rec.id !== "number") return null;
  if (rec.op === "ingest") return { id: rec.id, op: "ingest" };
  if (rec.op === "cap" && typeof rec.key === "string" && (rec.value === "oldest" || rec.value === "none")) {
    return { id: rec.id, op: "cap", key: rec.key, value: rec.value };
  }
  if (rec.op === "get" && typeof rec.key === "string") {
    return { id: rec.id, op: "get", key: rec.key };
  }
  if (
    rec.op === "put" &&
    typeof rec.key === "string" &&
    typeof rec.value === "string"
  ) {
    return { id: rec.id, op: "put", key: rec.key, value: rec.value };
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

async function servePeer(db: Handle): Promise<void> {
  for (;;) {
    const res = await fetch("/peer/next");
    if (!res.ok) throw new Error(`peer next ${res.status}`);
    const cmd = parseCmd(await res.json());
    if (!cmd) throw new Error("bad peer command");
    try {
      switch (cmd.op) {
        case "put":
          await db.put(enc.encode(cmd.key), enc.encode(cmd.value));
          await postResult({
            id: cmd.id,
            ok: true,
            value: null,
            generation: null,
            error: null,
          });
          break;
        case "get": {
          await db.sync();
          const got = text(await db.get(enc.encode(cmd.key)));
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
          const { generation } = await db.ingest();
          await postResult({
            id: cmd.id,
            ok: true,
            value: null,
            generation,
            error: null,
          });
          break;
        }
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
    async put(key, value) {
      await callPeer({ op: "put", key, value });
    },
    async get(key) {
      const result = await callPeer({ op: "get", key });
      return result.value;
    },
    async ingest() {
      const result = await callPeer({ op: "ingest" });
      must(typeof result.generation === "number", "ingest missing generation");
      return result.generation;
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
    const fs = await testing.openBrowserFs(DB_NAME);
    const host = new testing.EngineHost(() => fs);
    const ingest = testing.createLocalIngestClient(host);
    const shared = { fs, ingest };
    const self = await openHandle(mod, testing, "tab-a", shared);
    const otherDb = await openHandle(mod, testing, "tab-b", shared);
    const other: OtherTab = {
      async put(key, value) {
        await otherDb.put(enc.encode(key), enc.encode(value));
      },
      async get(key) {
        await otherDb.sync();
        return text(await otherDb.get(enc.encode(key)));
      },
      async ingest() {
        const { generation } = await otherDb.ingest();
        return generation;
      },
      cap: () => Promise.reject(new Error("the pressure scenario needs two tabs")),
    };
    await scenario(self, other);
    await self.close();
    await otherDb.close();
    return;
  }

  if (ROLE === "b") {
    const db = await openHandle(mod, testing, "tab-b");
    log("mode=" + modeLabel());
    log("tab B ready");
    const ready = await fetch("/peer/ready", { method: "POST" });
    if (!ready.ok) throw new Error("ready rejected");
    await servePeer(db);
    return;
  }

  const db = await openHandle(mod, testing, "tab-a");
  if (QUOTA) await quotaScenario();
  else if (PRESSURE) await pressureScenario(await remoteOther());
  else await scenario(db, await remoteOther());
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

if (AUTO) {
  runBtn.disabled = true;
  void finish();
}

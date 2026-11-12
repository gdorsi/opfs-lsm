/**
 * Tab A puts, warms SST readers, and must still get the key after tab B ingests.
 * Then tab A range-deletes rows, some flushed and some not, and tab B must
 * read them as absent before and after it ingests. Last, tab A puts a row
 * with an expiry: tab B reads it before the deadline, also after it
 * ingests the row, and reads it as absent once the deadline passes.
 *
 *   ?auto=1&role=a     leader tab
 *   ?auto=1&role=b     peer tab
 *   ?local=1           one page, two handles, one EngineHost
 *   ?nobc=1            drop BroadcastChannel messages before openDb
 *   ?scenario=pressure a database over maxBytes, with handlers in both tabs
 *                      and then with none
 */
const params = new URLSearchParams(location.search);
const ROLE = params.get("role");
const LOCAL = params.has("local");
const NOBC = params.has("nobc");
const AUTO = params.has("auto");
const DB_NAME = params.get("name") ?? "two-tab";
const PRESSURE = params.get("scenario") === "pressure";

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
  put(key: Uint8Array, value: Uint8Array, options?: { expiresAt?: number }): Promise<unknown>;
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
  cap(name: string, mode: CapMode): Promise<void>;
  capReport(name: string): Promise<CapReport>;
};

type PeerCmd =
  | { id: number; op: "put"; key: string; value: string }
  | { id: number; op: "get"; key: string }
  | { id: number; op: "ingest" }
  | { id: number; op: "cap"; key: string; value: CapMode }
  | { id: number; op: "cap-report"; key: string };

/** A handle opened with maxBytes: with an oldest-first handler, or with none. */
type CapMode = "oldest" | "none";
type CapReport = { calls: number; through: number | null; warns: number; rows: number };

const CAP = 16 * 1024 * 1024;
const CAP_ROWS = 1600;
const CAP_VALUE = 16 * 1024;
const capKey = (i: number) => enc.encode(`r${String(i).padStart(5, "0")}`);

type Capped = {
  readonly db: Handle & {
    onPressure(handler: (p: { through: number }) => Promise<void>): () => void;
    batch(body: (tx: { put(key: Uint8Array, value: Uint8Array): void; deleteRange(bounds: object, options?: { through?: number }): void }) => void): Promise<number>;
  };
  calls: number;
  through: number | null;
};
const capped = new Map<string, Capped>();

const warnsByName = new Map<string, number>();
if (PRESSURE) {
  const warn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    const line = String(args[0]);
    for (const name of capped.keys()) {
      if (line.includes(`"${name}"`) && line.includes("onPressure")) warnsByName.set(name, (warnsByName.get(name) ?? 0) + 1);
    }
    warn(...args);
  };
}

async function openCapped(name: string, mode: CapMode): Promise<Capped> {
  const testing = await import("../dist/testing.js");
  const db = (await testing.openHarnessDb({ name, maxBytes: CAP, maxWalBytes })) as unknown as Capped["db"];
  const handle: Capped = { db: Object.assign(db, { ingest: () => testing.ingest(db as never) }), calls: 0, through: null };
  capped.set(name, handle);
  if (mode === "oldest") {
    db.onPressure(async ({ through }) => {
      handle.calls += 1;
      handle.through = through;
      await db.batch((tx) => tx.deleteRange({}, { through }));
    });
  }
  return handle;
}

async function capReport(name: string): Promise<CapReport> {
  const handle = capped.get(name)!;
  await handle.db.sync();
  let rows = 0;
  for await (const _ of handle.db.range()) rows += 1;
  return { calls: handle.calls, through: handle.through, warns: warnsByName.get(name) ?? 0, rows };
}

/** Writes rows past the cap; returns the seq each row was written at. */
async function fillPastCap(handle: Capped): Promise<number[]> {
  const seqs: number[] = [];
  for (let i = 0; i < CAP_ROWS; i += 16) {
    const seq = await handle.db.batch((tx) => {
      for (let j = i; j < i + 16; j++) tx.put(capKey(j), new Uint8Array(CAP_VALUE).fill(j % 251));
    });
    for (let j = i; j < i + 16; j++) seqs[j] = seq;
  }
  await handle.db.ingest();
  return seqs;
}

async function poll(cond: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const quiet = () => new Promise((resolve) => setTimeout(resolve, 1500));

/**
 * One database over maxBytes with an oldest-first handler in each tab:
 * exactly one tab answers, and both tabs read the rows it left. Then one
 * with no handler in either tab: each tab warns once.
 */
async function pressureScenario(other: OtherTab): Promise<void> {
  log(`mode=${modeLabel()}`);
  const answered = `${DB_NAME}-cap`;
  const self = await openCapped(answered, "oldest");
  await other.cap(answered, "oldest");
  const seqs = await fillPastCap(self);
  await poll(async () => self.calls + (await other.capReport(answered)).calls > 0, "a handler call");
  await self.db.ingest();
  await quiet();
  const mine = await capReport(answered);
  const theirs = await other.capReport(answered);
  must(mine.calls + theirs.calls === 1, `handlers ran ${mine.calls} times in tab A and ${theirs.calls} in tab B`);
  const through = (mine.through ?? theirs.through)!;
  const expected = seqs.filter((seq) => seq > through).length;
  must(mine.rows === expected && theirs.rows === expected, `tabs read ${mine.rows} and ${theirs.rows} rows, expected ${expected}`);
  must(expected * (CAP_VALUE + 6) <= CAP, `${expected} rows are still over maxBytes`);
  must(mine.warns + theirs.warns === 0, "a tab warned though a handler answered");
  log(`pressure answered by tab ${mine.calls === 1 ? "A" : "B"} through=${through}`);
  log(`both tabs read ${expected} of ${CAP_ROWS} rows`);

  const unanswered = `${DB_NAME}-nohandler`;
  const bare = await openCapped(unanswered, "none");
  await other.cap(unanswered, "none");
  await fillPastCap(bare);
  await poll(async () => (await capReport(unanswered)).warns > 0 && (await other.capReport(unanswered)).warns > 0, "warnings");
  await quiet();
  const a = await capReport(unanswered);
  const b = await other.capReport(unanswered);
  must(a.warns === 1 && b.warns === 1, `warnings: tab A ${a.warns}, tab B ${b.warns}`);
  must(a.rows === CAP_ROWS && b.rows === CAP_ROWS, "a row went missing with no handler");
  log("no handler: one warning in each tab");
  log("pressure ok");
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

  const deadline = Date.now() + 2_000;
  await self.put(enc.encode("ttl"), enc.encode("live"), { expiresAt: deadline });
  const early = await other.get("ttl");
  must(early === "live", `other tab read ttl=${early} before its deadline`);
  await other.ingest();
  const flushedEarly = await other.get("ttl");
  must(Date.now() < deadline, "the expiry step ran past its deadline before the second read");
  must(flushedEarly === "live", `other tab read ttl=${flushedEarly} after ingesting it, before its deadline`);
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now()) + 50));
  const late = await other.get("ttl");
  must(late === null, `other tab read ttl=${late} after its deadline`);
  const own = text(await self.get(enc.encode("ttl")));
  must(own === null, `tab A read ttl=${own} after its deadline`);
  log("other tab saw ttl present before its deadline and absent after");

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
  if (rec.op === "cap-report" && typeof rec.key === "string") return { id: rec.id, op: "cap-report", key: rec.key };
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
        case "cap":
          await openCapped(cmd.key, cmd.value);
          await postResult({ id: cmd.id, ok: true, value: null, generation: null, error: null });
          break;
        case "cap-report":
          await postResult({ id: cmd.id, ok: true, value: JSON.stringify(await capReport(cmd.key)), generation: null, error: null });
          break;
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
      await callPeer({ op: "cap", key: name, value: mode });
    },
    async capReport(name) {
      const result = await callPeer({ op: "cap-report", key: name });
      return JSON.parse(result.value!) as CapReport;
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
      capReport: () => Promise.reject(new Error("the pressure scenario needs two tabs")),
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
  if (PRESSURE) await pressureScenario(await remoteOther());
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

/**
 * Page side of the Chrome kill loop (`scripts/kill-chrome.ts`). The harness
 * drives it over CDP: `Runtime.evaluate` calls `kc.*`, and the page reports
 * each acked write through the `kcAck` binding as soon as the ack resolves,
 * so the harness holds every ack it saw before a kill.
 *
 * `/src/*.js` is served from `dist/`, so `checkDatabase` (tests/sim) and
 * the engine share one module graph and one wasm instance.
 */
import { OpfsLsmError } from "../src/index.js";
import { openBrowserFs, openHarnessDb, ingest, ensureEngine } from "../src/testing.js";
import { checkDatabase, walMeta, walRows } from "../tests/sim/check-database.js";
import { decodeGeneration, listRuns } from "../src/store/generation.js";
import { decodeSst } from "../src/store/sst.js";
import { attempts, type WorkOp } from "./kill-chrome-workload.js";

type Db = Awaited<ReturnType<typeof openHarnessDb>>;

type Binding = (payload: string) => void;

const enc = new TextEncoder();
const dec = new TextDecoder();
const statusEl = document.getElementById("status")!;

function bind(name: string): Binding {
  const fn = (globalThis as unknown as Record<string, Binding | undefined>)[name];
  return fn ? (payload) => fn(payload) : () => undefined;
}

function errorInfo(err: unknown): { name: string; message: string; typed: boolean } {
  const e = err as { name?: unknown; message?: unknown };
  return {
    name: typeof e?.name === "string" ? e.name : typeof err,
    message: typeof e?.message === "string" ? e.message : String(err),
    typed: err instanceof OpfsLsmError,
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Hold the compaction and ingest locks, in the host's order, so no ingest,
 * compaction or reclaim runs while `fn` reads the files: `checkDatabase`
 * wants a quiet database.
 */
function quiet<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return navigator.locks.request(`opfs-lsm-compact/${name}`, () =>
    navigator.locks.request(`opfs-lsm-ingest/${name}`, fn),
  ) as unknown as Promise<T>;
}

// --- Workload.

type WorkConfig = {
  name: string;
  seed: number;
  iteration: number;
  tab: number;
  maxWalBytes: number;
};

let work:
  | { stop: boolean; done: Promise<WorkResult>; db: Db }
  | undefined;

type WorkResult = {
  acked: number;
  error: { n: number; name: string; message: string; typed: boolean } | null;
};

async function apply(db: Db, ops: readonly WorkOp[]): Promise<number> {
  const only = ops.length === 1 ? ops[0]! : undefined;
  if (only?.type === "put") return db.put(enc.encode(only.key), enc.encode(only.value));
  if (only?.type === "del") return db.delete(enc.encode(only.key));
  return db.batch((tx) => {
    for (const op of ops) {
      if (op.type === "put") tx.put(enc.encode(op.key), enc.encode(op.value));
      else tx.delete(enc.encode(op.key));
    }
  });
}

async function start(cfg: WorkConfig): Promise<void> {
  if (work) throw new Error("workload already running");
  const ack = bind("kcAck");
  const writerId = `t${cfg.tab}-i${cfg.iteration}`;
  const db = await openHarnessDb({
    name: cfg.name,
    writerId,
    maxWalBytes: cfg.maxWalBytes,
  });
  const state = { stop: false, db, done: Promise.resolve<WorkResult>({ acked: 0, error: null }) };
  state.done = (async (): Promise<WorkResult> => {
    let n = 0;
    for (const ops of attempts(cfg.seed, cfg.iteration, cfg.tab)) {
      if (state.stop) break;
      n += 1;
      let seq: number;
      try {
        seq = await apply(db, ops);
      } catch (err) {
        const info = errorInfo(err);
        bind("kcError")(JSON.stringify({ tab: cfg.tab, n, ...info }));
        return { acked: n - 1, error: { n, ...info } };
      }
      ack(JSON.stringify({ tab: cfg.tab, n, seq }));
    }
    return { acked: n, error: null };
  })();
  work = state;
  statusEl.textContent = `working tab=${cfg.tab}`;
}

async function stop(): Promise<WorkResult> {
  const w = work;
  if (!w) return { acked: 0, error: null };
  w.stop = true;
  const result = await w.done;
  await w.db.close();
  work = undefined;
  statusEl.textContent = "stopped";
  return result;
}

/** Ingest now through this tab's workload handle. */
async function ingestNow(): Promise<{ ok: boolean; generation: number | null; error: ReturnType<typeof errorInfo> | null }> {
  if (!work) throw new Error("no workload handle");
  try {
    const { generation } = await withTimeout(ingest(work.db), 20_000, "ingest");
    return { ok: true, generation, error: null };
  } catch (err) {
    return { ok: false, generation: null, error: errorInfo(err) };
  }
}

// --- Check after recovery.

type CheckConfig = { name: string; keys: string[]; probe: string };

type Snapshot = {
  head: number;
  ingestedThrough: number;
  generation: number | null;
  runs: number;
  orphans: number;
  staleManifests: number;
  emptyManifests: number;
  swapFiles: string[];
  problems: string[];
  state: [string, string][];
};

async function snapshot(name: string): Promise<Snapshot> {
  const fs = await openBrowserFs(name);
  const report = await quiet(name, () => checkDatabase(fs, name));
  return {
    head: report.head,
    ingestedThrough: report.ingestedThrough,
    generation: report.generation ?? null,
    runs: report.runs.length,
    orphans: report.orphans.length,
    staleManifests: report.staleManifests.length,
    emptyManifests: report.emptyManifests.length,
    swapFiles: [...report.swapFiles],
    problems: [...report.problems],
    state: report.state.map((e) => [dec.decode(e.key), dec.decode(e.value)]),
  };
}

type CheckResult = {
  open: { ok: boolean; error: ReturnType<typeof errorInfo> | null };
  before?: Snapshot;
  range?: [string, string][];
  gets?: Record<string, string | null>;
  restart?: { generationBefore: number; generationAfter: number; probe: string | null; ms: number };
  after?: Snapshot;
  error?: ReturnType<typeof errorInfo>;
};

/**
 * Open the database (recovery runs here), check the files, read every key
 * through the handle, then prove the SharedWorker works: write, ingest,
 * read back, and check the files again.
 */
async function check(cfg: CheckConfig): Promise<CheckResult> {
  await ensureEngine();
  let db: Db;
  try {
    db = await withTimeout(openHarnessDb({ name: cfg.name, writerId: "check", maxWalBytes: 1 << 30 }), 20_000, "open");
  } catch (err) {
    return { open: { ok: false, error: errorInfo(err) } };
  }
  const out: CheckResult = { open: { ok: true, error: null } };
  try {
    out.before = await withTimeout(snapshot(cfg.name), 30_000, "checkDatabase");
    const range: [string, string][] = [];
    for (const e of await db.range()) range.push([dec.decode(e.key), dec.decode(e.value)]);
    out.range = range;
    const gets: Record<string, string | null> = {};
    for (const k of cfg.keys) {
      const v = await db.get(enc.encode(k));
      gets[k] = v ? dec.decode(v) : null;
    }
    out.gets = gets;

    const t0 = performance.now();
    const generationBefore = out.before.generation ?? 0;
    await db.put(enc.encode("~probe"), enc.encode(cfg.probe));
    const { generation: generationAfter } = await withTimeout(ingest(db), 20_000, "ingest after restart");
    const probe = await db.get(enc.encode("~probe"));
    out.restart = {
      generationBefore,
      generationAfter,
      probe: probe ? dec.decode(probe) : null,
      ms: Math.round(performance.now() - t0),
    };
    out.after = await withTimeout(snapshot(cfg.name), 30_000, "checkDatabase after ingest");
  } catch (err) {
    out.error = errorInfo(err);
  } finally {
    await db.close().catch(() => undefined);
  }
  return out;
}

// --- Probes for the platform checks.

type HeldLock = { name: string; mode: string };

async function locks(): Promise<{ held: HeldLock[]; pending: HeldLock[] }> {
  const snap = await navigator.locks.query();
  const pick = (l: LockInfo) => ({ name: l.name ?? "", mode: l.mode ?? "" });
  return { held: (snap.held ?? []).map(pick), pending: (snap.pending ?? []).map(pick) };
}

/** Take each lock and never release it. Resolves once all are granted. */
async function holdLocks(wanted: HeldLock[]): Promise<void> {
  await Promise.all(
    wanted.map(
      (l) =>
        new Promise<void>((granted) => {
          void navigator.locks.request(l.name, { mode: l.mode as LockMode }, () => {
            granted();
            return new Promise<never>(() => undefined);
          });
        }),
    ),
  );
}

/** True when an exclusive request for `name` is granted at once. */
async function lockFree(name: string): Promise<boolean> {
  return (await navigator.locks.request(name, { ifAvailable: true }, (lock) => lock !== null)) as boolean;
}

async function probeDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle("kc-probe", { create: true });
}

/** Write `size` bytes of `fill` to `kc-probe/<file>` and close the writer. */
async function writeProbe(file: string, size: number, fill: number): Promise<void> {
  const handle = await (await probeDir()).getFileHandle(file, { create: true });
  const w = await handle.createWritable();
  await w.write(new Uint8Array(size).fill(fill));
  await w.close();
}

/** Kept so a writer left open is not collected (which would abort it). */
const openWriters: FileSystemWritableFileStream[] = [];

/** Start overwriting `kc-probe/<file>` and leave the writer open. */
async function writeProbeOpen(file: string, size: number, fill: number): Promise<void> {
  const handle = await (await probeDir()).getFileHandle(file, { create: true });
  const w = await handle.createWritable();
  openWriters.push(w);
  const chunk = new Uint8Array(1 << 20).fill(fill);
  for (let at = 0; at < size; at += chunk.byteLength) await w.write(chunk.subarray(0, Math.min(chunk.byteLength, size - at)));
}

async function readProbe(file: string): Promise<{ size: number; fills: number[] } | null> {
  try {
    const handle = await (await probeDir()).getFileHandle(file);
    const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
    return { size: bytes.byteLength, fills: [...new Set(bytes)].sort((a, b) => a - b) };
  } catch (err) {
    if ((err as { name?: string }).name === "NotFoundError") return null;
    throw err;
  }
}

/** Every path in the origin private file system. */
async function opfsTree(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: FileSystemDirectoryHandle, prefix: string) => {
    const it = (dir as FileSystemDirectoryHandle & { entries(): AsyncIterableIterator<[string, FileSystemHandle]> }).entries();
    for await (const [name, handle] of it) {
      const path = prefix + name;
      if (handle.kind === "directory") await walk(handle as FileSystemDirectoryHandle, `${path}/`);
      else out.push(path);
    }
  };
  await walk(await navigator.storage.getDirectory(), "");
  return out.sort();
}

async function estimate(): Promise<{ usage: number; quota: number }> {
  const e = await navigator.storage.estimate();
  return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
}

/**
 * In the browser that survived a kill: open the database in this tab,
 * write, and ingest through whatever SharedWorker the tab gets.
 */
async function restartInPlace(
  name: string,
  value: string,
): Promise<{ ok: boolean; ms: number; seq: number | null; error: string | null }> {
  const t0 = performance.now();
  let db: Db | undefined;
  let seq: number | null = null;
  try {
    db = await withTimeout(openHarnessDb({ name, writerId: "in-place", maxWalBytes: 1 << 30 }), 15_000, "open");
    seq = await db.put(enc.encode("~in-place"), enc.encode(value));
    await withTimeout(ingest(db), 15_000, "ingest");
    return { ok: true, ms: Math.round(performance.now() - t0), seq, error: null };
  } catch (err) {
    return { ok: false, ms: Math.round(performance.now() - t0), seq, error: errorInfo(err).message };
  } finally {
    if (db) await withTimeout(db.close(), 5_000, "close").catch(() => undefined);
  }
}

/**
 * Every file of a database as it lies, without opening it (no recovery):
 * the WAL meta and keys, each manifest, and each run with its seq span and
 * the entries of the keys that match `pattern`.
 */
async function inspect(name: string, pattern: string): Promise<unknown> {
  await ensureEngine();
  const fs = await openBrowserFs(name);
  const re = new RegExp(pattern);
  // indexedDB.databases() first: opening a missing WAL would create it.
  const databases = (await indexedDB.databases()).map((d) => d.name ?? "");
  const lsm = await (await navigator.storage.getDirectory()).getDirectoryHandle("opfs-lsm", { create: true });
  const dirs: string[] = [];
  for await (const [n] of (lsm as FileSystemDirectoryHandle & { entries(): AsyncIterableIterator<[string, FileSystemHandle]> }).entries()) dirs.push(n);
  const hasWal = databases.includes(`opfs-lsm-wal/${name}`);
  const meta = hasWal ? await walMeta(name).catch((e: Error) => e.message) : null;
  const rows = hasWal ? await walRows(name).catch(() => []) : [];
  const manifests: unknown[] = [];
  for (const file of [...(await fs.list("m"))].sort()) {
    const buf = (await fs.read(`m/${file}`, 0, Number.POSITIVE_INFINITY)) ?? new Uint8Array(0);
    try {
      const g = decodeGeneration(buf);
      manifests.push({ file, bytes: buf.byteLength, generation: g.generation, through: g.through, tombstoneSeq: g.tombstoneSeq, runs: g.runs.map((r) => r.path) });
    } catch (err) {
      manifests.push({ file, bytes: buf.byteLength, error: errorInfo(err).message });
    }
  }
  const runs: unknown[] = [];
  for (const path of (await listRuns(fs)).sort()) {
    const buf = (await fs.read(path, 0, Number.POSITIVE_INFINITY)) ?? new Uint8Array(0);
    try {
      const entries = decodeSst(buf);
      const seqs = entries.map((e) => e.seq ?? 0);
      runs.push({
        path,
        bytes: buf.byteLength,
        entries: entries.length,
        seqs: seqs.length ? [Math.min(...seqs), Math.max(...seqs)] : [],
        keys: entries.length ? [dec.decode(entries[0]!.key), dec.decode(entries[entries.length - 1]!.key)] : [],
        match: entries
          .filter((e) => re.test(dec.decode(e.key)))
          .map((e) => ({ key: dec.decode(e.key), seq: e.seq, kind: e.kind, value: e.kind === "put" ? dec.decode(e.value).slice(0, 40) : null })),
      });
    } catch (err) {
      runs.push({ path, bytes: buf.byteLength, error: errorInfo(err).message });
    }
  }
  const keys = rows.map((r) => r.seq);
  return { databases: databases.sort(), opfsDatabases: dirs.sort(), meta, wal: keys.length ? [keys[0], keys[keys.length - 1], keys.length] : [], manifests, runs };
}

/** Names of the origin's IndexedDB databases. */
async function idbNames(): Promise<string[]> {
  return (await indexedDB.databases()).map((d) => d.name ?? "").sort();
}

/** Open a handle and keep it, so this page connects to the SharedWorker. */
let kept: Db | undefined;
async function connect(name: string): Promise<void> {
  kept ??= await openHarnessDb({ name, writerId: `probe-${crypto.randomUUID()}`, maxWalBytes: 1 << 30 });
}

Object.assign(globalThis, {
  kc: {
    start,
    stop,
    check,
    locks,
    holdLocks,
    lockFree,
    writeProbe,
    writeProbeOpen,
    readProbe,
    opfsTree,
    estimate,
    connect,
    restartInPlace,
    ingestNow,
    inspect,
    idbNames,
    ready: true,
  },
});
statusEl.textContent = "ready";

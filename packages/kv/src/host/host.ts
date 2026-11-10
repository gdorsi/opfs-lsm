import type { DbName } from "../check.js";
import { OpfsLsmError } from "../errors.js";
import { compactLock, ingestLock, tryLock, unlessHeld, withLock } from "../locks.js";
import { logLockName } from "../log/log-worker-boot.js";
import type { AsyncFs } from "../opfs/async-fs.js";
import { CountingFs } from "../opfs/counting-fs.js";
import { newestIntact } from "../recover.js";
import { listRuns, manifestNumbers, probeManifest, reclaimRuns } from "../store/generation.js";
import { levelOf } from "../store/levels.js";
import { installMerged, mergeNextStep } from "./compact.js";
import { layersChannel, parsePageToHost, type GenerationNote, type HostStats, type HostToPage, type PageToHost } from "./protocol.js";
import { ingestQueues, reclaimQueues, type IngestOutcome, type LogLocks } from "./queue-host.js";
import type { LogId, QueueCursor, RecordN } from "./queues.js";

export type FsFactory = (name: DbName) => AsyncFs | Promise<AsyncFs>;

/** How the host paces ingest and bounds L0. */
export type HostLimits = {
  /** Key and value bytes one ingest folds into its L0 run, at most. A larger backlog takes several rounds. */
  readonly runBytes: number;
  /** L0 runs at which ingest waits for a compaction install. One less than a merge's sources, so one step can take all of L0. */
  readonly l0StopRuns: number;
  /** Flushed bytes waiting that start an ingest at once. */
  readonly batchBytes: number;
  /** The longest a flushed record waits for an ingest when `batchBytes` did not start one. */
  readonly maxLatencyMs: number;
};

const DEFAULT_HOST_LIMITS: HostLimits = {
  runBytes: 2 * 1024 * 1024,
  l0StopRuns: 15,
  batchBytes: 1024 * 1024,
  maxLatencyMs: 1000,
};

/** How long a sync waits for the other pages to flush. */
const FLUSH_WAIT_MS = 500;

/** Compaction steps per pass. A real database's cascade needs far fewer. */
const MAX_COMPACTION_STEPS = 8;

/** The port calls the host makes: a SharedWorker connection, or one end of a MessageChannel in tests. */
export type HostPort = {
  postMessage(msg: unknown): void;
  addEventListener(type: "message", listener: (ev: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (ev: MessageEvent) => void): void;
  start?(): void;
};

type Page = { readonly post: (msg: HostToPage) => void; db: HostDb | undefined };

/** A live log's last flushed record and the body bytes through it. */
type Hint = { readonly n: RecordN; readonly bytes: number };

/**
 * When the next background round runs. `armed`: hints are waiting below
 * `batchBytes`, and the timer starts a round `maxLatencyMs` after the
 * first. `queued`: a background round waits for its turn; hints that
 * arrive once it started arm the next one.
 */
type Trigger = { readonly kind: "idle" } | { readonly kind: "armed"; readonly cancel: () => void } | { readonly kind: "queued" };

/** A `flush` the host sent, and the pages that have not answered it. */
type Ask = { readonly pending: Set<Page>; readonly done: () => void };

type Ingested = Extract<IngestOutcome, { kind: "ingested" }>;

type HostCounts = { flushes: number; l0Stops: number; compactionSteps: number; foldedBytes: number };

type HostDb = {
  readonly name: DbName;
  readonly fs: CountingFs;
  readonly locks: LogLocks;
  readonly pages: Set<Page>;
  readonly hints: Map<LogId, Hint>;
  /** Body bytes hinted since the last round began. */
  waiting: number;
  trigger: Trigger;
  /** Rounds run one at a time, in call order. */
  rounds: Promise<unknown>;
  compaction: Promise<boolean> | undefined;
  compactAgain: boolean;
  /** Run files out of a manifest that were still held at the last sweep. Undefined before the first. */
  retired: Set<string> | undefined;
  readonly asks: Map<number, Ask>;
  readonly counts: HostCounts;
};

function after(ms: number, fn: () => void): () => void {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
}

/** A hinted log the cursors have not reached. */
function behind(hints: ReadonlyMap<LogId, Hint>, queues: readonly QueueCursor[]): boolean {
  const cursors = new Map(queues.map((c) => [c.log, c]));
  for (const [log, hint] of hints) {
    const c = cursors.get(log);
    if ((c?.state ?? "open") === "open" && hint.n > (c?.n ?? 0)) return true;
  }
  return false;
}

/**
 * The SharedWorker side of the database. Per database it ingests the tabs'
 * logs into L0 runs, compacts, reclaims, and tells the tabs about each new
 * manifest on `layersChannel`. Ingest order is the only order: a tab reads
 * the manifests and its own records the manifest does not cover yet.
 *
 * A round runs when the flushed bytes the tabs report pass `batchBytes`,
 * `maxLatencyMs` after the first report otherwise, and at once for a
 * `sync`. Every manifest publish holds the ingest Web Lock, so two hosts of
 * one database, say two builds whose script URLs differ, take turns.
 */
export class Host {
  private readonly dbs = new Map<DbName, Promise<HostDb>>();
  private readonly limits: HostLimits;
  private nextAsk = 1;

  constructor(
    private readonly fsFactory: FsFactory,
    limits: Partial<HostLimits> = {},
  ) {
    this.limits = { ...DEFAULT_HOST_LIMITS, ...limits };
  }

  /** Serve one page's port. Returns its stop. */
  serve(port: HostPort): () => void {
    const page: Page = { post: (msg) => port.postMessage(msg), db: undefined };
    const listener = (ev: MessageEvent): void => {
      const msg = parsePageToHost(ev.data);
      if (msg) this.onMessage(page, msg);
    };
    port.addEventListener("message", listener);
    port.start?.();
    return () => {
      port.removeEventListener("message", listener);
      this.detach(page);
    };
  }

  private onMessage(page: Page, msg: PageToHost): void {
    const db = page.db;
    switch (msg.t) {
      case "attach":
        void this.reply(page, msg.id, async () => {
          const attached = await this.dbFor(msg.db);
          page.db = attached;
          attached.pages.add(page);
          return { t: "done", id: msg.id, generation: await this.drain(attached, page) };
        });
        return;
      case "durable":
        if (db) this.hint(db, msg.log, msg.n, msg.bytes);
        return;
      case "sync":
        if (db) void this.reply(page, msg.id, async () => ({ t: "done", id: msg.id, generation: await this.drain(db, page) }));
        return;
      case "settle":
        if (db) void this.reply(page, msg.id, async () => ({ t: "done", id: msg.id, generation: await this.settle(db, page) }));
        return;
      case "flushed":
        if (db) this.flushed(db, page, msg.id);
        return;
      case "stats":
        if (db) void this.reply(page, msg.id, async () => ({ t: "stats", id: msg.id, stats: await this.stats(db) }));
        return;
      case "detach":
        this.detach(page);
        return;
    }
  }

  private async reply(page: Page, id: number, answer: () => Promise<HostToPage>): Promise<void> {
    try {
      page.post(await answer());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      page.post(err instanceof OpfsLsmError ? { t: "failed", id, message, code: err.code } : { t: "failed", id, message });
    }
  }

  private dbFor(name: DbName): Promise<HostDb> {
    let db = this.dbs.get(name);
    if (!db) {
      db = (async (): Promise<HostDb> => ({
        name,
        fs: new CountingFs(await this.fsFactory(name)),
        locks: { take: (log) => tryLock(logLockName(name, log)) },
        pages: new Set(),
        hints: new Map(),
        waiting: 0,
        trigger: { kind: "idle" },
        rounds: Promise.resolve(),
        compaction: undefined,
        compactAgain: false,
        retired: undefined,
        asks: new Map(),
        counts: { flushes: 0, l0Stops: 0, compactionSteps: 0, foldedBytes: 0 },
      }))();
      this.dbs.set(name, db);
      db.catch(() => this.dbs.delete(name));
    }
    return db;
  }

  private detach(page: Page): void {
    const db = page.db;
    if (!db || !db.pages.delete(page)) return;
    for (const [id] of db.asks) this.flushed(db, page, id);
    // Its log is dead once its dedicated WebWorker lets the lock go.
    this.wake(db);
  }

  private hint(db: HostDb, log: LogId, n: RecordN, bytes: number): void {
    const prev = db.hints.get(log);
    if (prev && prev.n >= n) return;
    db.waiting += Math.max(0, bytes - (prev?.bytes ?? 0));
    db.hints.set(log, { n, bytes });
    this.wake(db);
  }

  /** A background round now when `batchBytes` wait or `now`, or the latency timer if none is armed. */
  private wake(db: HostDb, now = false): void {
    const t = db.trigger;
    if (t.kind === "queued") return;
    if (now || db.waiting >= this.limits.batchBytes) {
      if (t.kind === "armed") t.cancel();
      db.trigger = { kind: "queued" };
      void this.background(db);
    } else if (t.kind === "idle") {
      db.trigger = {
        kind: "armed",
        cancel: after(this.limits.maxLatencyMs, () => {
          db.trigger = { kind: "idle" };
          this.wake(db, true);
        }),
      };
    }
  }

  private async background(db: HostDb): Promise<void> {
    let out: Ingested;
    try {
      out = await this.round(db, db.hints, () => (db.trigger = { kind: "idle" }));
    } catch (err) {
      // The next hint tries again, so a database recovery refuses does not spin.
      console.error(`opfs-lsm: ingest of ${db.name} failed`, err);
      return;
    }
    if (out.more) {
      this.wake(db, true);
      return;
    }
    if (out.stuck.length > 0) void this.ask(db, out.stuck);
    if (behind(db.hints, out.queues)) this.wake(db);
  }

  /**
   * What a `sync` and an open promise: the other pages flush (or 500 ms
   * pass), then rounds run until the logs are ingested through the hints
   * known then, and dead logs to their end. A log Chrome would not let a
   * round read gets one rotation and one more round.
   */
  private async drain(db: HostDb, asker: Page): Promise<number> {
    await this.ask(db, [], asker);
    const want = new Map(db.hints);
    for (let rotated = false; ; ) {
      const out = await this.round(db, want);
      if (out.more) continue;
      if (out.stuck.length > 0 && !rotated) {
        rotated = true;
        await this.ask(db, out.stuck);
        continue;
      }
      return out.generation;
    }
  }

  /** `drain`, then compaction until a pass installs nothing. */
  private async settle(db: HostDb, asker: Page): Promise<number> {
    await this.drain(db, asker);
    while (await this.compact(db));
    return (await newestIntact(db.fs.inner)).base.generation;
  }

  /**
   * One ingest round, after every round asked for before it. While L0 is
   * full it waits for a compaction pass, and goes ahead past the limit when
   * that pass installed nothing, since waiting longer would wait for nothing.
   */
  private round(db: HostDb, hints: ReadonlyMap<LogId, Hint>, started?: () => void): Promise<Ingested> {
    const run = async (): Promise<Ingested> => {
      started?.();
      db.waiting = 0;
      const durable = new Map([...hints].map(([log, h]) => [log, h.n]));
      for (let pastStop = false; ; ) {
        const stop = pastStop ? Number.POSITIVE_INFINITY : this.limits.l0StopRuns;
        const out = await withLock(ingestLock(db.name), () => ingestQueues(db.fs, db.locks, durable, this.limits.runBytes, stop));
        if (out.kind === "stalled") {
          db.counts.l0Stops += 1;
          pastStop = !(await this.compact(db).catch(() => false));
          continue;
        }
        for (const c of out.queues) if (c.state !== "open") db.hints.delete(c.log);
        if (out.published) {
          if (out.records > 0) db.counts.flushes += 1;
          db.counts.foldedBytes += out.bytes;
          announce(db.name, out.generation);
          this.compact(db).catch((err: unknown) => console.error(`opfs-lsm: compaction of ${db.name} failed`, err));
        }
        return out;
      }
    };
    const next = db.rounds.then(run, run);
    db.rounds = next.catch(() => undefined);
    return next;
  }

  /** Posts `flush` to every page but `except`, and resolves once each answered or `FLUSH_WAIT_MS` passed. */
  private ask(db: HostDb, rotate: readonly LogId[], except?: Page): Promise<void> {
    const pending = new Set([...db.pages].filter((p) => p !== except));
    if (pending.size === 0) return Promise.resolve();
    const id = this.nextAsk++;
    return new Promise((resolve) => {
      const done = (): void => {
        cancel();
        db.asks.delete(id);
        resolve();
      };
      const cancel = after(FLUSH_WAIT_MS, done);
      db.asks.set(id, { pending, done });
      for (const page of pending) page.post({ t: "flush", id, rotate });
    });
  }

  private flushed(db: HostDb, page: Page, id: number): void {
    const ask = db.asks.get(id);
    if (ask?.pending.delete(page) && ask.pending.size === 0) ask.done();
  }

  /** Runs compaction passes until no request arrives during one. True when one installed a step. */
  private compact(db: HostDb): Promise<boolean> {
    if (db.compaction) {
      db.compactAgain = true;
      return db.compaction;
    }
    const run = (async () => {
      let installed = false;
      try {
        do {
          db.compactAgain = false;
          if (await withLock(compactLock(db.name), () => this.compactPass(db))) installed = true;
        } while (db.compactAgain);
      } finally {
        db.compaction = undefined;
      }
      return installed;
    })();
    db.compaction = run;
    return run;
  }

  private async compactPass(db: HostDb): Promise<boolean> {
    await withLock(ingestLock(db.name), () => this.reclaim(db));
    let installed = false;
    for (let i = 0; i < MAX_COMPACTION_STEPS; i++) {
      const { base, top } = await newestIntact(db.fs);
      const step = await mergeNextStep(db.fs, base, top);
      if (!step) break;
      const generation = await withLock(ingestLock(db.name), async () => {
        const g = await installMerged(db.fs, step);
        for (const path of step.inputs) db.retired?.add(path);
        await this.reclaim(db);
        return g;
      });
      db.counts.compactionSteps += 1;
      installed = true;
      announce(db.name, generation);
    }
    return installed;
  }

  /**
   * Removes what no kept manifest needs: covered segments, dead logs and
   * old manifests (`reclaimQueues`), then the run files no manifest on disk
   * lists and no tab holds. The first sweep looks at every run file, which
   * also collects an L0 a crashed round left. Call holding the ingest and
   * compaction locks, so no run being written looks like an orphan.
   * Skipped while a tab loads a generation (`holdingFiles`).
   */
  private async reclaim(db: HostDb): Promise<void> {
    await unlessHeld(db.name, async () => {
      await reclaimQueues(db.fs, db.locks);
      const keep = await manifestRuns(db.fs);
      if (!keep) return;
      const retired = db.retired ?? new Set(await listRuns(db.fs));
      db.retired = new Set(await reclaimRuns(db.fs, retired, keep));
    });
  }

  private async stats(db: HostDb): Promise<HostStats> {
    const { base } = await newestIntact(db.fs.inner);
    const byLevel = new Map<number, { level: number; runs: number; bytes: number }>();
    for (const run of base.runs) {
      const level = levelOf(run.path) ?? 0;
      const entry = byLevel.get(level) ?? { level, runs: 0, bytes: 0 };
      entry.runs += 1;
      entry.bytes += run.bytes;
      byLevel.set(level, entry);
    }
    return structuredClone({
      fs: db.fs.counters,
      ...db.counts,
      generation: base.generation,
      layout: [...byLevel.values()].sort((a, b) => a.level - b.level),
    });
  }
}

/** Every run a manifest in `m/` lists. Undefined when one does not decode: nothing may be swept against it. */
async function manifestRuns(fs: AsyncFs): Promise<string[] | undefined> {
  const runs: string[] = [];
  for (const n of await manifestNumbers(fs)) {
    const m = await probeManifest(fs, n);
    if (m === "corrupt") return undefined;
    if (m !== "missing") runs.push(...m.runs.map((r) => r.path));
  }
  return runs;
}

/** Tells the tabs to load `generation`. */
function announce(name: DbName, generation: number): void {
  if (typeof BroadcastChannel === "undefined") return;
  const bus = new BroadcastChannel(layersChannel(name));
  const note: GenerationNote = { generation };
  bus.postMessage(note);
  bus.close();
}

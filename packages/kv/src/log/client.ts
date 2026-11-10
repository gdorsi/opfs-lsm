import { checkDbName, type CheckedOp, type DbName } from "../check.js";
import { ClosedError, CommitError, IndeterminateWriteError } from "../errors.js";
import type { LogId, PredEdge, RecordN } from "../host/queues.js";
import { encodeOps } from "../idb/wal.js";
import type { LogCommand, LogToPage, PageToLog } from "./log-worker-boot.js";

/** A request with no answer in this long gives its log up. */
const WRITE_TIMEOUT_MS = 10_000;
/** An ack is flushed at most this long after it arrived. */
const FLUSH_DELAY_MS = 100;

/** One dedicated WebWorker as the client drives it. */
export type LogWorkerPort = {
  post(msg: PageToLog, transfer: Transferable[]): void;
  terminate(): void;
};

/** Starts a dedicated WebWorker running `log-worker.ts` and routes its events. */
export type SpawnLogWorker = (events: { message(data: unknown): void; error(): void }) => LogWorkerPort;

export type Clock = {
  /** Runs `fn` after `ms` and returns its cancel. */
  after(ms: number, fn: () => void): () => void;
};

export type LogClientOptions = {
  readonly db: string;
  readonly segmentBytes: number;
  readonly spawn?: SpawnLogWorker;
  readonly clock?: Clock;
  /** Records 1..n of `log` are flushed. The wiring sends it to the host as the log's durable hint. */
  readonly durable?: (log: LogId, n: RecordN) => void;
  /** `log` opened with `pred` in its first header: after a log was given up, or on resume. */
  readonly respawned?: (log: LogId, pred: PredEdge) => void;
};

export type Acked = { readonly log: LogId; readonly n: RecordN };

type Pending = { readonly body: Uint8Array; readonly resolve: (at: Acked) => void; readonly reject: (err: unknown) => void };

/** What a sent command owes its caller once answered. */
type Owed = { readonly t: "append"; readonly batch: readonly Pending[] } | { readonly t: "open" | "flush" | "rotate" | "close"; readonly done?: () => void };

type Request = Owed & { readonly cancel: () => void };

type Log = {
  readonly id: LogId;
  readonly pred: PredEdge | undefined;
  readonly port: LogWorkerPort;
  /**
   * The pred a successor names: this log through its last ack once it
   * opened. Before that, this log's own pred, since a log that never
   * opened holds no record and must not cut the chain.
   */
  handoff: PredEdge | undefined;
  durable: RecordN;
  readonly requests: Map<number, Request>;
  flushTimer: (() => void) | undefined;
};

type Ended = { readonly promise: Promise<void>; readonly resolve: () => void };

/**
 * `live`: one log, appends gathered into `queued` and sent one batch at a
 * time. `handing-over`: `old` failed after it opened and is given up, and
 * its successor `log`, whose first header caps `old` at its last ack, is
 * opening. Nothing more is sent to `old`, and its dedicated WebWorker runs
 * on, holding `old`'s lock, until `log` acks its open. Owed: `old.requests`,
 * what was sent to `old` and not answered. Queued: `queued`, appends not
 * sent anywhere yet, which go to `log` once it opened. `ending`: its close
 * is sent. In both, what comes after is `next`, and appends wait in
 * `queued` unless that is a close. `suspended`: no log, appends wait for
 * `resume`. `down`: a log failed before it opened; the next append starts one.
 */
type State =
  | { readonly kind: "live"; readonly log: Log; readonly queued: Pending[] }
  | {
      readonly kind: "handing-over";
      readonly old: Log;
      readonly why: string;
      readonly log: Log;
      readonly next: "suspend" | "resume" | "close";
      readonly queued: Pending[];
      readonly ended: Ended;
    }
  | {
      readonly kind: "ending";
      readonly log: Log;
      readonly next: "suspend" | "resume" | "close";
      readonly queued: Pending[];
      readonly ended: Ended;
    }
  | { readonly kind: "suspended"; readonly pred: PredEdge | undefined; readonly queued: Pending[] }
  | { readonly kind: "down"; readonly pred: PredEdge | undefined }
  | { readonly kind: "closed" };

type Live = Extract<State, { kind: "live" }>;
type HandingOver = Extract<State, { kind: "handing-over" }>;

function deferred(): Ended {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const realClock: Clock = {
  after(ms, fn) {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

function spawnBrowserLogWorker(events: { message(data: unknown): void; error(): void }): LogWorkerPort {
  // Inline in the constructor: bundlers emit a chunk for the dedicated WebWorker only for this exact shape.
  const worker = new Worker(new URL("./log-worker.js", import.meta.url), { type: "module", name: "opfs-lsm-log" });
  worker.onmessage = (ev) => events.message(ev.data);
  worker.onerror = () => events.error();
  worker.onmessageerror = () => events.error();
  return {
    post: (msg, transfer) => worker.postMessage(msg, transfer),
    terminate: () => worker.terminate(),
  };
}

function newLogId(): LogId {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  if (bytes.every((b) => b === 0)) bytes[7] = 1;
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("") as LogId;
}

function parseLogToPage(data: unknown): LogToPage | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const m = data as Record<string, unknown>;
  if (!Number.isSafeInteger(m.id)) return undefined;
  const id = m.id as number;
  if (m.t === "done" && Number.isInteger(m.n) && (m.n as number) >= 0) return { t: "done", id, n: m.n as number };
  if (m.t === "failed" && typeof m.message === "string") return { t: "failed", id, message: m.message };
  return undefined;
}

const hasAppend = (log: Log): boolean => [...log.requests.values()].some((r) => r.t === "append");
const opened = (log: Log): boolean => log.handoff?.log === log.id;

/**
 * This page's writer of ingest queues. Each `append` is one record, acked
 * once its write() returned in the dedicated WebWorker that owns the
 * current log. Appends resolve in call order. A failed write, a request
 * with no answer in `WRITE_TIMEOUT_MS`, an error event or a message the
 * dedicated WebWorker should not send gives the log up. Its successor's
 * first header names `pred { log, lastN }` with the last ack this page
 * saw, and the old dedicated WebWorker, which holds the old log's lock, is
 * terminated only once that header is flushed. The host takes a log's lock
 * before it lists the logs, so it finds the cap whenever it reads the old
 * log as dead: it ingests the old log through the last ack and nothing of
 * it past that, all before the successor's records.
 */
export class LogClient {
  private readonly db: DbName;
  private readonly segmentBytes: number;
  private readonly spawn: SpawnLogWorker;
  private readonly clock: Clock;
  private readonly onDurable: ((log: LogId, n: RecordN) => void) | undefined;
  private readonly onRespawned: ((log: LogId, pred: PredEdge) => void) | undefined;
  private state: State = { kind: "closed" };
  private nextId = 1;

  constructor(options: LogClientOptions) {
    this.db = checkDbName(options.db);
    this.segmentBytes = options.segmentBytes;
    this.spawn = options.spawn ?? spawnBrowserLogWorker;
    this.clock = options.clock ?? realClock;
    this.onDurable = options.durable;
    this.onRespawned = options.respawned;
    this.start(undefined, []);
  }

  /**
   * Appends `ops` as one record. Rejects with `CommitError` when the record
   * is never ingested: it was never sent, or it was sent to a log that a
   * successor's header capped below it. Rejects with
   * `IndeterminateWriteError` when it was sent and nothing could cap its
   * log: the successor did not open, or the log was ending. It may then
   * still be ingested, but never after a later append of this client.
   * Rejects with `ClosedError` once `close` was called.
   */
  append(ops: readonly CheckedOp[]): Promise<Acked> {
    const body = new Uint8Array(encodeOps(ops));
    return new Promise((resolve, reject) => {
      const p: Pending = { body, resolve, reject };
      const s = this.state;
      switch (s.kind) {
        case "live":
          s.queued.push(p);
          if (s.queued.length === 1 && !hasAppend(s.log)) queueMicrotask(() => this.pump());
          return;
        case "handing-over":
        case "ending":
          if (s.next === "close") reject(new ClosedError("log client is closing"));
          else s.queued.push(p);
          return;
        case "suspended":
          s.queued.push(p);
          return;
        case "down":
          this.start(s.pred, [p]);
          return;
        case "closed":
          reject(new ClosedError("log client is closed"));
          return;
      }
    });
  }

  /**
   * Flushes every record acked before the call. Resolves at once when no
   * log is live: the acked records then sit in logs that are ending or given
   * up, which the host reads through their last ack without a durable hint
   * once their dedicated WebWorker is gone.
   */
  flush(): Promise<void> {
    const s = this.state;
    if (s.kind !== "live") return Promise.resolve();
    s.log.flushTimer?.();
    s.log.flushTimer = undefined;
    return new Promise((done) => this.send(s.log, { t: "flush" }, { t: "flush", done }));
  }

  /** Seals the live log's segment and starts the next, so the host can read a file that no longer changes. */
  rotate(): Promise<void> {
    const s = this.state;
    if (s.kind !== "live") return Promise.resolve();
    return new Promise((done) => this.send(s.log, { t: "rotate" }, { t: "rotate", done }));
  }

  /**
   * Ends the live log so its dedicated WebWorker releases its lock and
   * handle, for a page going into the back/forward cache. The close is
   * posted before this returns. Appends wait for `resume`.
   */
  suspend(): Promise<void> {
    const s = this.state;
    switch (s.kind) {
      case "live":
        return this.end(s, "suspend");
      case "handing-over":
      case "ending":
        if (s.next === "resume") this.state = { ...s, next: "suspend" };
        return s.ended.promise;
      case "down":
        this.state = { kind: "suspended", pred: s.pred, queued: [] };
        return Promise.resolve();
      case "suspended":
      case "closed":
        return Promise.resolve();
    }
  }

  /** Starts a new log whose first header names the suspended one, and sends the appends that waited. */
  resume(): void {
    const s = this.state;
    if (s.kind === "suspended") this.start(s.pred, s.queued);
    else if ((s.kind === "ending" || s.kind === "handing-over") && s.next === "suspend") this.state = { ...s, next: "resume" };
  }

  /** Sends what was appended before the call, then flushes and closes the log and ends its dedicated WebWorker. */
  close(): Promise<void> {
    const s = this.state;
    switch (s.kind) {
      case "live":
        return this.end(s, "close");
      case "handing-over":
      case "ending":
        if (s.next !== "close") this.state = { ...s, next: "close" };
        return s.ended.promise;
      case "suspended":
        for (const p of s.queued) p.reject(new ClosedError("log client is closed"));
        this.state = { kind: "closed" };
        return Promise.resolve();
      case "down":
        this.state = { kind: "closed" };
        return Promise.resolve();
      case "closed":
        return Promise.resolve();
    }
  }

  private start(pred: PredEdge | undefined, queued: Pending[]): void {
    const log = this.spawnLog(pred);
    if (log instanceof Error) {
      for (const p of queued) p.reject(new CommitError(log.message));
      this.state = { kind: "down", pred };
      return;
    }
    this.state = { kind: "live", log, queued };
    if (queued.length > 0) queueMicrotask(() => this.pump());
  }

  /** Spawns a log's dedicated WebWorker and sends its open, or says why it could not. */
  private spawnLog(pred: PredEdge | undefined): Log | Error {
    const id = newLogId();
    let port: LogWorkerPort;
    try {
      port = this.spawn({ message: (data) => this.onMessage(log, data), error: () => this.lost(log, "its dedicated WebWorker failed") });
    } catch (err) {
      return new Error(`log ${id} did not start: ${err instanceof Error ? err.message : String(err)}`);
    }
    const log: Log = { id, pred, port, handoff: pred, durable: 0, requests: new Map(), flushTimer: undefined };
    const open = { t: "open", db: this.db, log: id, segmentBytes: this.segmentBytes } as const;
    this.send(log, pred ? { ...open, pred } : open, { t: "open" });
    return log;
  }

  private pump(): void {
    const s = this.state;
    if (s.kind === "live" && s.queued.length > 0 && !hasAppend(s.log)) this.sendAppend(s.log, s.queued.splice(0));
  }

  private sendAppend(log: Log, batch: Pending[]): void {
    const bodies = batch.map((p) => p.body);
    this.send(log, { t: "append", bodies }, { t: "append", batch }, bodies.map((b) => b.buffer as ArrayBuffer));
  }

  private send(log: Log, cmd: LogCommand, owed: Owed, transfer: Transferable[] = []): void {
    const id = this.nextId++;
    const cancel = this.clock.after(WRITE_TIMEOUT_MS, () => this.lost(log, `no answer in ${WRITE_TIMEOUT_MS} ms`));
    log.requests.set(id, { ...owed, cancel });
    const msg: PageToLog = { ...cmd, id };
    log.port.post(msg, transfer);
  }

  private end(s: Live, next: "suspend" | "close", ended = deferred()): Promise<void> {
    const { log } = s;
    log.flushTimer?.();
    log.flushTimer = undefined;
    if (next === "close" && s.queued.length > 0) this.sendAppend(log, s.queued.splice(0));
    this.state = { kind: "ending", log, next, queued: s.queued, ended };
    this.send(log, { t: "close" }, { t: "close" });
    return ended.promise;
  }

  /** `log` is the one this client listens to: the live or ending log, or the successor a hand-over waits on. */
  private current(log: Log): boolean {
    const s = this.state;
    return (s.kind === "live" || s.kind === "ending" || s.kind === "handing-over") && s.log === log;
  }

  private onMessage(log: Log, data: unknown): void {
    if (!this.current(log)) return;
    const msg = parseLogToPage(data);
    const req = msg && log.requests.get(msg.id);
    if (!msg || !req) {
      this.lost(log, "it sent an unknown message");
      return;
    }
    if (msg.t === "failed") {
      // A log that never opened holds no record, so nothing sent to it can land.
      this.lost(log, `failed: ${msg.message}`, opened(log));
      return;
    }
    log.requests.delete(msg.id);
    req.cancel();
    switch (req.t) {
      case "open":
        log.handoff = { log: log.id, lastN: msg.n };
        if (log.pred) this.onRespawned?.(log.id, log.pred);
        if (this.state.kind === "handing-over") this.handedOver(this.state);
        return;
      case "append": {
        const first = msg.n - req.batch.length + 1;
        log.handoff = { log: log.id, lastN: msg.n };
        req.batch.forEach((p, i) => p.resolve({ log: log.id, n: first + i }));
        if (this.state.kind !== "live") return;
        log.flushTimer ??= this.clock.after(FLUSH_DELAY_MS, () => {
          log.flushTimer = undefined;
          this.send(log, { t: "flush" }, { t: "flush" });
        });
        this.pump();
        return;
      }
      case "flush":
        if (msg.n > log.durable) {
          log.durable = msg.n;
          this.onDurable?.(log.id, msg.n);
        }
        req.done?.();
        return;
      case "rotate":
        req.done?.();
        return;
      case "close":
        this.retire(log, undefined);
        return;
    }
  }

  /**
   * `log` failed: a failed reply, no answer in time, an error event or a
   * message it should not send. `landed`: what was sent to it may be on disk.
   */
  private lost(log: Log, why: string, landed = true): void {
    const s = this.state;
    if (!this.current(log)) return;
    const what = `log ${log.id}: ${why}`;
    if (s.kind === "handing-over") this.handOverFailed(s, what);
    else if (s.kind === "live" && opened(log)) this.handOver(s, what);
    else this.retire(log, landed ? new IndeterminateWriteError(what) : new CommitError(what));
  }

  /** Gives `s.log` up, keeping its dedicated WebWorker and lock until a successor that caps it has opened. */
  private handOver(s: Live, why: string): void {
    const old = s.log;
    old.flushTimer?.();
    old.flushTimer = undefined;
    const log = this.spawnLog(old.handoff);
    if (log instanceof Error) {
      this.abandon(old, `${why}; ${log.message}`, s.queued);
      this.state = { kind: "down", pred: old.handoff };
      return;
    }
    this.state = { kind: "handing-over", old, why, log, next: "resume", queued: s.queued, ended: deferred() };
  }

  /** The successor's header is flushed, so nothing sent to `old` past its last ack is ever ingested. */
  private handedOver(s: HandingOver): void {
    s.old.port.terminate();
    this.settle(s.old, new CommitError(`${s.why}; log ${s.log.id} caps it at record ${s.old.handoff?.lastN}`));
    const live: Live = { kind: "live", log: s.log, queued: s.queued };
    this.state = live;
    if (s.next !== "resume") {
      void this.end(live, s.next, s.ended);
      return;
    }
    s.ended.resolve();
    this.pump();
  }

  /** The successor did not open, so nothing caps `old`: once its lock is free the host reads it to its end. */
  private handOverFailed(s: HandingOver, why: string): void {
    s.log.port.terminate();
    this.settle(s.log, new CommitError(why));
    this.abandon(s.old, `${s.why}; ${why}`, s.queued);
    const pred = s.old.handoff;
    switch (s.next) {
      case "resume":
        this.state = { kind: "down", pred };
        break;
      case "suspend":
        this.state = { kind: "suspended", pred, queued: [] };
        break;
      case "close":
        this.state = { kind: "closed" };
        break;
    }
    s.ended.resolve();
  }

  private abandon(old: Log, why: string, queued: readonly Pending[]): void {
    old.port.terminate();
    this.settle(old, new IndeterminateWriteError(why));
    for (const p of queued) p.reject(new CommitError(`not sent: ${why}`));
  }

  /** Settles what `log` still owed: an append rejects with `failure`, anything else resolves, since an ended log needs no flush or rotation. */
  private settle(log: Log, failure: Error): void {
    log.flushTimer?.();
    log.flushTimer = undefined;
    for (const req of log.requests.values()) {
      req.cancel();
      if (req.t === "append") for (const p of req.batch) p.reject(failure);
      else req.done?.();
    }
    log.requests.clear();
  }

  /**
   * Terminates the log's dedicated WebWorker, settles what it still owed and
   * moves on. Reached on a clean close, and on a failure that nothing can
   * cap: the log never opened, or it is ending and its dedicated WebWorker
   * frees its lock by itself once it reads the close.
   */
  private retire(log: Log, cause: Error | undefined): void {
    log.port.terminate();
    const failure = cause ?? new ClosedError(`log ${log.id} closed`);
    this.settle(log, failure);

    const s = this.state;
    if (s.kind === "live") {
      for (const p of s.queued) p.reject(new CommitError(`log ${log.id} did not open: ${failure.message}`));
      this.state = { kind: "down", pred: log.handoff };
      return;
    }
    if (s.kind !== "ending") return;
    switch (s.next) {
      case "suspend":
        this.state = { kind: "suspended", pred: log.handoff, queued: s.queued };
        break;
      case "resume":
        this.start(log.handoff, s.queued);
        break;
      case "close":
        for (const p of s.queued) p.reject(new ClosedError("log client is closed"));
        this.state = { kind: "closed" };
        break;
    }
    s.ended.resolve();
  }
}

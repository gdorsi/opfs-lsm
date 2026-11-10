import { describe, expect, it } from "vitest";
import type { CheckedKey, CheckedOp, CheckedValue, DbName } from "../src/check.js";
import { ClosedError, CommitError, IndeterminateWriteError } from "../src/errors.js";
import { planIngest, type LogId, type PredEdge, type RecordN } from "../src/host/queues.js";
import { LogClient, type Clock, type LogWorkerPort, type SpawnLogWorker } from "../src/log/client.js";
import { logLockName, serveLog } from "../src/log/log-worker-boot.js";
import { scanLog, type ListedSegment } from "../src/log/queue-scan.js";
import type { SegmentFile } from "../src/log/queue-writer.js";
import { parseSegmentName, segmentPath } from "../src/log/segment.js";

const DB = "log-client";
const enc = new TextEncoder();
const dec = new TextDecoder();

const op = (label: string, pad = 0): CheckedOp[] => [
  { type: "put", key: enc.encode(label) as CheckedKey, value: enc.encode(label.padEnd(label.length + pad, ".")) as CheckedValue },
];
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

class FakeClock implements Clock {
  private now = 0;
  private timers: { at: number; fn: () => void }[] = [];

  after(ms: number, fn: () => void): () => void {
    const t = { at: this.now + ms, fn };
    this.timers.push(t);
    return () => (this.timers = this.timers.filter((x) => x !== t));
  }

  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    await settle();
    for (;;) {
      const due = this.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.now = due.at;
      due.fn();
      await settle();
    }
    this.now = end;
  }
}

class FakeFile implements SegmentFile {
  bytes = new Uint8Array(0);
  flushed = 0;

  constructor(private readonly opfs: FakeOpfs) {}

  /** `landed`: every byte is written and the write still throws, as an I/O error reported late. */
  write(data: Uint8Array, at: number): number {
    const fault = this.opfs.nextWrite;
    this.opfs.nextWrite = undefined;
    const landed = fault === "short" ? data.length >> 1 : fault === "throw" ? 0 : data.length;
    if (at + landed > this.bytes.length) {
      const grown = new Uint8Array(at + landed);
      grown.set(this.bytes);
      this.bytes = grown;
    }
    this.bytes.set(data.subarray(0, landed), at);
    this.opfs.writes++;
    if (fault === "throw" || fault === "landed") throw new Error("injected write failure");
    return landed;
  }

  flush(): void {
    this.flushed = this.bytes.length;
  }

  close(): void {}
}

/**
 * A dedicated WebWorker running the real message loop. `stall` holds every
 * message it receives, like a thread stuck in a sync write, until
 * `unstall`. `mute` writes but never answers. `garble` writes and answers
 * with a message the page cannot parse. `dead` drops everything without an
 * error event.
 */
class FakeWorker implements LogWorkerPort {
  mode: "run" | "stall" | "mute" | "garble" | "dead" = "run";
  log: LogId | undefined;
  /** Closed by itself: it reads no more messages, but what it posted still arrives. */
  private exited = false;
  private terminated = false;
  private readonly held: (() => void)[] = [];
  private readonly onMessage: (data: unknown) => void;

  constructor(
    private readonly opfs: FakeOpfs,
    private readonly events: { message(data: unknown): void; error(): void },
  ) {
    this.onMessage = serveLog({
      lock: async (name) => {
        if (opfs.locks.has(name)) return undefined;
        opfs.locks.set(name, this);
        return () => opfs.release(name);
      },
      segments: async () => ({
        create: async (log, firstN) => {
          if (opfs.failOpen) throw new Error("injected open failure");
          const file = new FakeFile(opfs);
          opfs.files.set(segmentPath(log, firstN), file);
          return file;
        },
      }),
      post: (msg) => {
        if (this.exited || this.terminated || this.mode === "mute" || this.mode === "dead") return;
        const copy = this.mode === "garble" ? { garbled: true } : structuredClone(msg);
        const deliver = (): void => {
          if (!this.terminated) this.events.message(copy);
        };
        if (opfs.pageFrozen) opfs.frozen.push(deliver);
        else queueMicrotask(deliver);
      },
      exit: () => this.end("exited"),
    });
  }

  post(msg: Parameters<LogWorkerPort["post"]>[0], transfer: Transferable[]): void {
    if (msg.t === "open") this.log = msg.log;
    this.opfs.trail.push(`${msg.t} ${this.log}`);
    const copy = structuredClone(msg, { transfer });
    queueMicrotask(() => {
      if (this.exited || this.terminated || this.mode === "dead") return;
      if (this.mode === "stall") this.held.push(() => this.onMessage(copy));
      else this.onMessage(copy);
    });
  }

  /** Runs what it held, as a sync write that finally returns. */
  unstall(): void {
    this.mode = "run";
    for (const run of this.held.splice(0)) if (!this.exited && !this.terminated) run();
  }

  terminate(): void {
    this.opfs.trail.push(`terminate ${this.log}`);
    this.end("terminated");
  }

  fail(): void {
    this.events.error();
  }

  private end(how: "exited" | "terminated"): void {
    this[how] = true;
    for (const [name, holder] of this.opfs.locks) if (holder === this) this.opfs.release(name);
  }
}

/** Every segment file's written and flushed bytes, and the logs whose lock is held. */
type Disk = {
  readonly written: ReadonlyMap<string, Uint8Array>;
  readonly flushed: ReadonlyMap<string, Uint8Array>;
  readonly held: ReadonlySet<LogId>;
};

const logsOn = (disk: Disk): LogId[] => [...new Set([...disk.written.keys()].map((p) => p.split("/")[1] as LogId))];

function listed(disk: Disk, log: LogId, upTo: "written" | "flushed" = "written"): ListedSegment[] {
  const out: ListedSegment[] = [];
  for (const [path, bytes] of disk[upTo]) {
    const [, l, name] = path.split("/");
    if (l === log) out.push({ firstN: parseSegmentName(name!)!, bytes });
  }
  return out;
}

/** The pred in `log`'s first header, as far as it is flushed. */
const flushedPred = (disk: Disk, log: LogId): PredEdge | undefined => scanLog(log, 0, false, listed(disk, log, "flushed")).pred;

/** Labels of `log`'s whole records, read as a dead log. */
const wholeIn = (disk: Disk, log: LogId): string[] => scanLog(log, 0, true, listed(disk, log)).records.map((r) => label(r.ops));

/** What a host would ingest from `disk`, in order: a log is dead when its lock is free, and live logs give nothing without a durable hint. */
function ingested(disk: Disk): string[] {
  const scans = logsOn(disk).map((log) => scanLog(log, 0, !disk.held.has(log), listed(disk, log)));
  return planIngest({ through: 0, queues: [] }, scans, new Map(), Infinity).records.map((r) => label(r.ops));
}

class FakeOpfs {
  readonly files = new Map<string, FakeFile>();
  readonly locks = new Map<string, FakeWorker>();
  readonly workers: FakeWorker[] = [];
  readonly trail: string[] = [];
  /** The disk the moment each log's lock went free. */
  readonly freed = new Map<LogId, Disk>();
  nextWrite: "throw" | "short" | "landed" | undefined;
  nextMode: FakeWorker["mode"] = "run";
  failOpen = false;
  failSpawn = false;
  pageFrozen = false;
  frozen: (() => void)[] = [];
  writes = 0;

  readonly spawn: SpawnLogWorker = (events) => {
    if (this.failSpawn) throw new Error("injected spawn failure");
    const w = new FakeWorker(this, events);
    w.mode = this.nextMode;
    this.nextMode = "run";
    this.workers.push(w);
    return w;
  };

  release(name: string): void {
    if (this.locks.delete(name)) this.freed.set(name.slice(name.lastIndexOf("/") + 1) as LogId, this.disk());
  }

  disk(): Disk {
    const copy = (upTo: (f: FakeFile) => Uint8Array) => new Map([...this.files].map(([path, f]) => [path, upTo(f).slice()]));
    return {
      written: copy((f) => f.bytes),
      flushed: copy((f) => f.bytes.subarray(0, f.flushed)),
      held: new Set([...this.locks.keys()].map((name) => name.slice(name.lastIndexOf("/") + 1) as LogId)),
    };
  }

  get worker(): FakeWorker {
    return this.workers[this.workers.length - 1]!;
  }

  thaw(): void {
    this.pageFrozen = false;
    for (const deliver of this.frozen.splice(0)) deliver();
  }

  logs(): LogId[] {
    return [...new Set([...this.files.keys()].map((p) => p.split("/")[1] as LogId))];
  }

  segments(log: LogId, upTo: "written" | "flushed" = "written"): ListedSegment[] {
    const out: ListedSegment[] = [];
    for (const [path, file] of this.files) {
      const [, l, name] = path.split("/");
      if (l !== log) continue;
      out.push({ firstN: parseSegmentName(name!)!, bytes: upTo === "written" ? file.bytes : file.bytes.subarray(0, file.flushed) });
    }
    return out;
  }

  /** Labels of `log`'s whole records, read as a dead log. */
  read(log: LogId, upTo: "written" | "flushed" = "written"): string[] {
    return scanLog(log, 0, true, this.segments(log, upTo)).records.map((r) => label(r.ops));
  }

  /** What the host would ingest once every log is dead, in ingest order. */
  applied(): string[] {
    const scans = this.logs().map((log) => scanLog(log, 0, true, this.segments(log)));
    return planIngest({ through: 0, queues: [] }, scans, new Map(), Infinity).records.map((r) => label(r.ops));
  }

  lockHeld(log: LogId): boolean {
    return this.locks.has(logLockName(DB as DbName, log));
  }
}

function label(ops: readonly CheckedOp[]): string {
  return ops[0] ? dec.decode(ops[0].key) : "?";
}

function setup(): {
  opfs: FakeOpfs;
  clock: FakeClock;
  client: LogClient;
  durable: [LogId, RecordN][];
  respawned: [LogId, PredEdge][];
} {
  const opfs = new FakeOpfs();
  const clock = new FakeClock();
  const durable: [LogId, RecordN][] = [];
  const respawned: [LogId, PredEdge][] = [];
  const client = new LogClient({
    db: DB,
    segmentBytes: 256,
    spawn: opfs.spawn,
    clock,
    durable: (log, n) => durable.push([log, n]),
    respawned: (log, pred) => respawned.push([log, pred]),
  });
  return { opfs, clock, client, durable, respawned };
}

/**
 * Settles `p` without letting a rejection go unhandled, so a test can look
 * at it later. `probe` runs the moment the caller hears back.
 */
function outcome<T, P = undefined>(
  p: Promise<T>,
  probe?: () => P,
): { readonly value?: T; readonly error?: unknown; readonly settled: boolean; readonly heldAtSettle?: P } {
  const o: { value?: T; error?: unknown; settled: boolean; heldAtSettle?: P } = { settled: false };
  p.then(
    (v) => Object.assign(o, { value: v, settled: true, heldAtSettle: probe?.() }),
    (e: unknown) => Object.assign(o, { error: e, settled: true, heldAtSettle: probe?.() }),
  );
  return o;
}

type Way = {
  readonly name: string;
  readonly arm: (opfs: FakeOpfs) => void;
  readonly trigger: (opfs: FakeOpfs, clock: FakeClock, old?: FakeWorker) => Promise<void>;
};

/** Ways a live log is given up while a write sent to it is unacked. Each lands at least that write's first frame whole. */
const givingUp: Way[] = [
  { name: "a failed reply to a write that landed whole", arm: (o) => (o.nextWrite = "landed"), trigger: () => settle() },
  { name: "a short write", arm: (o) => (o.nextWrite = "short"), trigger: () => settle() },
  { name: "no answer in 10 s", arm: (o) => (o.worker.mode = "mute"), trigger: (_, clock) => clock.advance(10_000) },
  {
    name: "an error event",
    arm: (o) => (o.worker.mode = "mute"),
    trigger: async (_, __, old) => {
      await settle();
      old!.fail();
    },
  },
  { name: "a message it should not send", arm: (o) => (o.worker.mode = "garble"), trigger: () => settle() },
];

/** Ways the successor of a given-up log fails to open. */
const notOpening: Way[] = [
  { name: "its spawn throws", arm: (o) => (o.failSpawn = true), trigger: () => settle() },
  { name: "its open fails", arm: (o) => (o.failOpen = true), trigger: () => settle() },
  { name: "its open gets no answer in 10 s", arm: (o) => (o.nextMode = "stall"), trigger: (_, clock) => clock.advance(10_000) },
  {
    name: "it reports an error",
    arm: (o) => (o.nextMode = "stall"),
    trigger: async (o) => {
      await settle();
      o.worker.fail();
    },
  },
];

describe("LogClient", () => {
  it("acks appends in call order, and appends made in one task share one write", async () => {
    const { opfs, client } = setup();
    await settle();
    const before = opfs.writes;
    const acks = await Promise.all(["a", "b", "c"].map((l) => client.append(op(l))));
    expect(acks.map((a) => a.n)).toEqual([1, 2, 3]);
    expect(opfs.writes - before).toBe(1);
    expect(await client.append(op("d"))).toEqual({ log: acks[0]!.log, n: 4 });
    expect(opfs.read(acks[0]!.log)).toEqual(["a", "b", "c", "d"]);
  });

  it.each(givingUp)("gives a log up on $name: its successor's header caps it before its lock is free, and the unacked writes are CommitErrors", async (way) => {
    const { opfs, clock, client, durable, respawned } = setup();
    const a = await client.append(op("a1"));
    const old = opfs.worker;
    way.arm(opfs);
    opfs.nextMode = "stall";
    const sent = [client.append(op("a2")), client.append(op("a3", 100))].map((p) => outcome(p, () => opfs.lockHeld(a.log)));
    await Promise.resolve();
    const queued = [client.append(op("b1"))];
    await way.trigger(opfs, clock, old);
    await settle();
    const successor = opfs.worker;
    expect(successor).not.toBe(old);
    expect(opfs.lockHeld(a.log)).toBe(true);
    expect(sent.map((s) => s.settled)).toEqual([false, false]);
    queued.push(client.append(op("b2")));
    await settle();
    expect(opfs.trail.filter((t) => t.endsWith(` ${successor.log}`))).toEqual([`open ${successor.log}`]);
    expect(opfs.trail.filter((t) => t.startsWith("append "))).toEqual([`append ${a.log}`, `append ${a.log}`]);

    successor.unstall();
    const b = await Promise.all(queued);
    expect(sent.map((s) => s.error)).toEqual([expect.any(CommitError), expect.any(CommitError)]);
    expect(sent.map((s) => s.heldAtSettle)).toEqual([false, false]);
    expect(b).toEqual([
      { log: successor.log, n: 1 },
      { log: successor.log, n: 2 },
    ]);
    expect(respawned).toEqual([[successor.log, { log: a.log, lastN: 1 }]]);
    const atFree = opfs.freed.get(a.log)!;
    expect(flushedPred(atFree, successor.log!)).toEqual({ log: a.log, lastN: 1 });
    expect(wholeIn(atFree, a.log).slice(0, 2)).toEqual(["a1", "a2"]);
    expect(ingested(atFree)).toEqual(["a1"]);
    expect(opfs.applied()).toEqual(["a1", "b1", "b2"]);
    expect(durable.filter(([log, n]) => log === a.log && n > 1)).toEqual([]);
  });

  it.each(notOpening)("when the successor fails ($name), the sent write is indeterminate and the queued one a CommitError", async (way) => {
    const { opfs, clock, client, respawned } = setup();
    const a = await client.append(op("a1"));
    opfs.nextWrite = "landed";
    way.arm(opfs);
    const sent = outcome(client.append(op("a2")));
    await Promise.resolve();
    const queued = outcome(client.append(op("b1")));
    await way.trigger(opfs, clock);
    await settle();

    expect(sent.error).toBeInstanceOf(IndeterminateWriteError);
    expect(queued.error).toBeInstanceOf(CommitError);
    expect(opfs.trail.filter((t) => t.startsWith("append "))).toEqual([`append ${a.log}`, `append ${a.log}`]);
    expect(opfs.locks.size).toBe(0);
    expect(ingested(opfs.freed.get(a.log)!)).toEqual(["a1", "a2"]);
    opfs.failSpawn = false;
    opfs.failOpen = false;
    const c = await client.append(op("c1"));
    expect(respawned.at(-1)).toEqual([c.log, { log: a.log, lastN: 1 }]);
    const order = opfs.applied();
    expect(order.filter((l) => l !== "a2")).toEqual(["a1", "c1"]);
    if (order.includes("a2")) expect(order.indexOf("a2")).toBeLessThan(order.indexOf("c1"));
  });

  it("never ingests a write that lands in a given-up log after its successor opened, even when its ack arrives first", async () => {
    const { opfs, clock, client, durable } = setup();
    const a = await client.append(op("a1"));
    const old = opfs.worker;
    old.mode = "stall";
    const late = outcome(client.append(op("a2")));
    await settle();
    opfs.pageFrozen = true;
    old.unstall();
    await clock.advance(10_000);
    expect(opfs.read(a.log)).toEqual(["a1", "a2"]);
    expect(opfs.lockHeld(a.log)).toBe(true);
    const successor = opfs.worker.log!;
    expect(flushedPred(opfs.disk(), successor)).toEqual({ log: a.log, lastN: 1 });

    opfs.thaw();
    await settle();
    expect(late.error).toBeInstanceOf(CommitError);
    expect(opfs.lockHeld(a.log)).toBe(false);
    expect(ingested(opfs.freed.get(a.log)!)).toEqual(["a1"]);
    expect(durable.filter(([log, n]) => log === a.log && n > 1)).toEqual([]);
    expect(await client.append(op("b1"))).toEqual({ log: successor, n: 1 });
    expect(opfs.applied()).toEqual(["a1", "b1"]);
  });

  it("gives a write with no answer in 10 s up as a CommitError, and frees its log's lock only then", async () => {
    const { opfs, clock, client, respawned } = setup();
    const a = await client.append(op("a1"));
    opfs.worker.mode = "stall";
    const pending = outcome(client.append(op("a2")));
    await clock.advance(9_999);
    expect(pending.settled).toBe(false);
    expect(opfs.lockHeld(a.log)).toBe(true);
    expect(opfs.workers.length).toBe(1);
    await clock.advance(1);
    expect(pending.error).toBeInstanceOf(CommitError);
    expect(opfs.lockHeld(a.log)).toBe(false);
    const b = await client.append(op("b1"));
    expect(b.log).not.toBe(a.log);
    expect(respawned).toEqual([[b.log, { log: a.log, lastN: 1 }]]);
    expect(opfs.applied()).toEqual(["a1", "b1"]);
  });

  it("treats a dedicated WebWorker that died silently as stuck once a write gets no answer", async () => {
    const { opfs, clock, client, respawned } = setup();
    const a = await client.append(op("a1"));
    await clock.advance(100);
    opfs.worker.mode = "dead";
    await clock.advance(60_000);
    const pending = outcome(client.append(op("a2")));
    await clock.advance(10_000);
    expect(pending.error).toBeInstanceOf(CommitError);
    const b = await client.append(op("b1"));
    expect(respawned).toEqual([[b.log, { log: a.log, lastN: 1 }]]);
    expect(opfs.applied()).toEqual(["a1", "b1"]);
  });

  it("suspend during a hand-over ends the successor once it opened; resume starts a log after it", async () => {
    const { opfs, client, respawned } = setup();
    const a = await client.append(op("a1"));
    opfs.nextWrite = "landed";
    opfs.nextMode = "stall";
    const sent = outcome(client.append(op("a2")));
    await Promise.resolve();
    const queued = outcome(client.append(op("b1")));
    await settle();
    const successor = opfs.worker;
    const suspended = outcome(client.suspend());
    await settle();
    expect(suspended.settled).toBe(false);
    expect(opfs.lockHeld(a.log)).toBe(true);

    successor.unstall();
    await settle();
    expect(suspended.settled).toBe(true);
    expect(sent.error).toBeInstanceOf(CommitError);
    expect(opfs.locks.size).toBe(0);
    expect(queued.settled).toBe(false);
    client.resume();
    await settle();
    expect(queued.value?.n).toBe(1);
    expect(respawned).toEqual([
      [successor.log, { log: a.log, lastN: 1 }],
      [queued.value!.log, { log: successor.log, lastN: 0 }],
    ]);
    expect(opfs.applied()).toEqual(["a1", "b1"]);
  });

  it("close during a hand-over sends the writes already called to the successor once it opened, then closes it", async () => {
    const { opfs, client } = setup();
    const a = await client.append(op("a1"));
    opfs.nextWrite = "landed";
    opfs.nextMode = "stall";
    const sent = outcome(client.append(op("a2")));
    await Promise.resolve();
    const queued = outcome(client.append(op("b1")));
    await settle();
    const successor = opfs.worker;
    const closed = outcome(client.close());
    await expect(client.append(op("late"))).rejects.toBeInstanceOf(ClosedError);
    expect(opfs.lockHeld(a.log)).toBe(true);
    successor.unstall();
    await settle();
    expect(closed.settled).toBe(true);
    expect(sent.error).toBeInstanceOf(CommitError);
    expect(queued.value).toEqual({ log: successor.log, n: 1 });
    expect(opfs.locks.size).toBe(0);
    expect(opfs.applied()).toEqual(["a1", "b1"]);
  });

  it("flushes at most 100 ms after the first unflushed ack and reports a durable n that is flushed", async () => {
    const { opfs, clock, client, durable } = setup();
    const [a] = await Promise.all([client.append(op("a1")), client.append(op("a2"))]);
    await clock.advance(99);
    expect(durable).toEqual([]);
    await client.append(op("a3"));
    await clock.advance(1);
    expect(durable).toEqual([[a!.log, 3]]);
    expect(opfs.read(a!.log, "flushed")).toEqual(["a1", "a2", "a3"]);

    for (let i = 4; i <= 23; i++) {
      await client.append(op(`a${i}`));
      await clock.advance(10);
    }
    await clock.advance(100);
    expect(durable.length).toBeLessThanOrEqual(1 + 3);
    expect(durable[durable.length - 1]).toEqual([a!.log, 23]);
    for (const [log, n] of durable) expect(opfs.read(log, "flushed").length).toBeGreaterThanOrEqual(n);
  });

  it("flushes every ack on request", async () => {
    const { opfs, client, durable } = setup();
    const a = await client.append(op("a1"));
    await client.flush();
    expect(durable).toEqual([[a.log, 1]]);
    expect(opfs.read(a.log, "flushed")).toEqual(["a1"]);
  });

  it("rotate leaves a segment that no later append changes", async () => {
    const { opfs, client } = setup();
    const a = await client.append(op("a1"));
    await client.rotate();
    const [sealed, ...rest] = opfs.segments(a.log);
    const before = sealed!.bytes.slice();
    expect(rest.length).toBe(1);
    await client.append(op("a2"));
    await client.append(op("a3"));
    expect(opfs.segments(a.log)[0]!.bytes).toEqual(before);
    expect(opfs.read(a.log)).toEqual(["a1", "a2", "a3"]);
  });

  it("suspend ends the log and frees its lock; resume starts a log after it and sends what waited", async () => {
    const { opfs, client, respawned } = setup();
    const a = await client.append(op("a1"));
    const suspending = client.suspend();
    const during = outcome(client.append(op("b1")));
    await suspending;
    expect(opfs.lockHeld(a.log)).toBe(false);
    const waited = outcome(client.append(op("b2")));
    await settle();
    expect(during.settled || waited.settled).toBe(false);
    expect(opfs.workers.length).toBe(1);
    client.resume();
    await settle();
    expect([during.value?.n, waited.value?.n]).toEqual([1, 2]);
    expect(respawned).toEqual([[waited.value!.log, { log: a.log, lastN: 1 }]]);
    expect(opfs.applied()).toEqual(["a1", "b1", "b2"]);
  });

  it("suspend frees the lock even when the page freezes before it hears back", async () => {
    const { opfs, client } = setup();
    const a = await client.append(op("a1"));
    const inFlight = outcome(client.append(op("a2")));
    opfs.pageFrozen = true;
    await Promise.resolve();
    const suspended = outcome(client.suspend());
    const during = outcome(client.append(op("b1")));
    await settle();
    expect(opfs.lockHeld(a.log)).toBe(false);
    expect(opfs.read(a.log)).toEqual(["a1", "a2"]);
    expect(suspended.settled).toBe(false);
    client.resume();
    opfs.thaw();
    await settle();
    expect(inFlight.value).toEqual({ log: a.log, n: 2 });
    expect(suspended.settled).toBe(true);
    expect(during.value?.n).toBe(1);
    expect(during.value?.log).not.toBe(a.log);
    expect(opfs.applied()).toEqual(["a1", "a2", "b1"]);
  });

  it("close sends the writes already called, then every acked write is on disk and later ones reject", async () => {
    const { opfs, client } = setup();
    const a = await client.append(op("a1"));
    const calls = ["a2", "a3", "a4"].map((l) => outcome(client.append(op(l))));
    await client.close();
    expect(calls.map((c) => c.value?.n)).toEqual([2, 3, 4]);
    expect(opfs.read(a.log, "flushed")).toEqual(["a1", "a2", "a3", "a4"]);
    expect(opfs.lockHeld(a.log)).toBe(false);
    await expect(client.append(op("late"))).rejects.toBeInstanceOf(ClosedError);
  });

  it("close with a failed write in flight: acked writes are on disk and every unacked one rejects", async () => {
    const { opfs, client } = setup();
    const a = await client.append(op("a1"));
    opfs.nextWrite = "throw";
    const inFlight = outcome(client.append(op("a2")));
    await Promise.resolve();
    const queued = outcome(client.append(op("a3")));
    await client.close();
    expect(inFlight.error).toBeInstanceOf(IndeterminateWriteError);
    expect(queued.error).toBeInstanceOf(IndeterminateWriteError);
    expect(opfs.read(a.log)).toEqual(["a1"]);
    expect(opfs.lockHeld(a.log)).toBe(false);
    expect(opfs.workers.length).toBe(1);
  });

  it("close with a stuck write: it resolves after 10 s, the write is indeterminate and the acked one is on disk", async () => {
    const { opfs, clock, client } = setup();
    const a = await client.append(op("a1"));
    opfs.worker.mode = "stall";
    const stuck = outcome(client.append(op("a2")));
    const closed = outcome(client.close());
    await clock.advance(10_000);
    expect(closed.settled).toBe(true);
    expect(stuck.error).toBeInstanceOf(IndeterminateWriteError);
    expect(opfs.read(a.log)).toEqual(["a1"]);
    expect(opfs.lockHeld(a.log)).toBe(false);
  });
});

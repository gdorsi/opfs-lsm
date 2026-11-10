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

const op = (label: string): CheckedOp[] => [{ type: "put", key: enc.encode(label) as CheckedKey, value: enc.encode(label) as CheckedValue }];
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
    if (fault === "throw") throw new Error("injected write failure");
    return landed;
  }

  flush(): void {
    this.flushed = this.bytes.length;
  }

  close(): void {}
}

/**
 * A dedicated WebWorker running the real message loop. `stall` holds every
 * message it receives, like a thread stuck in a sync write. `mute` writes
 * but never answers. `dead` drops everything without an error event.
 */
class FakeWorker implements LogWorkerPort {
  mode: "run" | "stall" | "mute" | "dead" = "run";
  log: LogId | undefined;
  /** Closed by itself: it reads no more messages, but what it posted still arrives. */
  private exited = false;
  private terminated = false;
  private readonly onMessage: (data: unknown) => void;

  constructor(
    private readonly opfs: FakeOpfs,
    private readonly events: { message(data: unknown): void; error(): void },
  ) {
    this.onMessage = serveLog({
      lock: async (name) => {
        if (opfs.locks.has(name)) return undefined;
        opfs.locks.set(name, this);
        return () => opfs.locks.delete(name);
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
        const copy = structuredClone(msg);
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
      if (this.exited || this.terminated || this.mode === "stall" || this.mode === "dead") return;
      this.onMessage(copy);
    });
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
    for (const [name, holder] of this.opfs.locks) if (holder === this) this.opfs.locks.delete(name);
  }
}

class FakeOpfs {
  readonly files = new Map<string, FakeFile>();
  readonly locks = new Map<string, FakeWorker>();
  readonly workers: FakeWorker[] = [];
  readonly trail: string[] = [];
  nextWrite: "throw" | "short" | undefined;
  failOpen = false;
  pageFrozen = false;
  frozen: (() => void)[] = [];
  writes = 0;

  readonly spawn: SpawnLogWorker = (events) => {
    const w = new FakeWorker(this, events);
    this.workers.push(w);
    return w;
  };

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
  const [first] = ops;
  return first?.type === "put" ? dec.decode(first.value) : "?";
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

/** Settles `p` without letting a rejection go unhandled, so a test can look at it later. */
function outcome<T>(p: Promise<T>): { readonly value?: T; readonly error?: unknown; readonly settled: boolean } {
  const o: { value?: T; error?: unknown; settled: boolean } = { settled: false };
  p.then(
    (v) => Object.assign(o, { value: v, settled: true }),
    (e: unknown) => Object.assign(o, { error: e, settled: true }),
  );
  return o;
}

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

  it("keeps call order across a failed write: the next log names the last ack and is ingested after it", async () => {
    const { opfs, client, respawned } = setup();
    const a = await client.append(op("a1"));
    await client.append(op("a2"));
    opfs.nextWrite = "short";
    const failed = outcome(client.append(op("a3")));
    await Promise.resolve();
    const b = await Promise.all([client.append(op("b1")), client.append(op("b2"))]);
    expect(failed.error).toBeInstanceOf(IndeterminateWriteError);
    expect(b.map((x) => x.n)).toEqual([1, 2]);
    expect(b[0]!.log).not.toBe(a.log);
    expect(respawned).toEqual([[b[0]!.log, { log: a.log, lastN: 2 }]]);
    const terminated = opfs.trail.indexOf(`terminate ${a.log}`);
    expect(terminated).toBeGreaterThanOrEqual(0);
    expect(terminated).toBeLessThan(opfs.trail.indexOf(`append ${b[0]!.log}`));
    expect(opfs.applied()).toEqual(["a1", "a2", "b1", "b2"]);
  });

  it("rejects a write with no answer in 10 s as indeterminate, terminates its dedicated WebWorker and moves on", async () => {
    const { opfs, clock, client, respawned } = setup();
    const a = await client.append(op("a1"));
    const stuck = opfs.worker;
    stuck.mode = "stall";
    const pending = outcome(client.append(op("a2")));
    await clock.advance(9_999);
    expect(pending.settled).toBe(false);
    expect(opfs.lockHeld(a.log)).toBe(true);
    await clock.advance(1);
    expect(pending.error).toBeInstanceOf(IndeterminateWriteError);
    expect(opfs.lockHeld(a.log)).toBe(false);
    const b = await client.append(op("b1"));
    expect(b.log).not.toBe(a.log);
    expect(respawned).toEqual([[b.log, { log: a.log, lastN: 1 }]]);
    expect(opfs.applied()).toEqual(["a1", "b1"]);
  });

  it("never orders a write that landed after its timeout behind a later write of the page", async () => {
    const { opfs, clock, client } = setup();
    await client.append(op("a1"));
    opfs.worker.mode = "mute";
    const late = outcome(client.append(op("a2")));
    await clock.advance(10_000);
    expect(late.error).toBeInstanceOf(IndeterminateWriteError);
    await client.append(op("b1"));
    const order = opfs.applied();
    expect(order.filter((l) => l !== "a2")).toEqual(["a1", "b1"]);
    if (order.includes("a2")) expect(order.indexOf("a2")).toBeLessThan(order.indexOf("b1"));
  });

  it("treats a dedicated WebWorker that died silently as stuck once a write gets no answer", async () => {
    const { opfs, clock, client, respawned } = setup();
    const a = await client.append(op("a1"));
    await clock.advance(100);
    opfs.worker.mode = "dead";
    await clock.advance(60_000);
    const pending = outcome(client.append(op("a2")));
    await clock.advance(10_000);
    expect(pending.error).toBeInstanceOf(IndeterminateWriteError);
    const b = await client.append(op("b1"));
    expect(respawned).toEqual([[b.log, { log: a.log, lastN: 1 }]]);
    expect(opfs.applied()).toEqual(["a1", "b1"]);
  });

  it("gives up an in-flight write at once when its dedicated WebWorker reports an error", async () => {
    const { opfs, client, respawned } = setup();
    const a = await client.append(op("a1"));
    opfs.worker.mode = "stall";
    const pending = outcome(client.append(op("a2")));
    await settle();
    opfs.worker.fail();
    await settle();
    expect(pending.error).toBeInstanceOf(IndeterminateWriteError);
    const b = await client.append(op("b1"));
    expect(respawned).toEqual([[b.log, { log: a.log, lastN: 1 }]]);
  });

  it("rejects writes that wait on a log that cannot open, then starts over on the next append", async () => {
    const { opfs, client, respawned } = setup();
    const a = await client.append(op("a1"));
    opfs.nextWrite = "throw";
    opfs.failOpen = true;
    const failed = outcome(client.append(op("a2")));
    await settle();
    const waiting = outcome(client.append(op("a3")));
    await settle();
    await settle();
    expect(failed.error).toBeInstanceOf(IndeterminateWriteError);
    expect(waiting.error).toBeInstanceOf(CommitError);
    opfs.failOpen = false;
    const b = await client.append(op("b1"));
    expect(b.n).toBe(1);
    expect(respawned).toEqual([[b.log, { log: a.log, lastN: 1 }]]);
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

import fc from "fast-check";
import { expect } from "vitest";
import type { CheckedKey, CheckedValue } from "../../src/check.js";
import { ingestQueues, reclaimQueues, type LogLocks } from "../../src/host/queue-host.js";
import { checkCover, RECLAIM_LAG, type LogFiles, type LogId, type PredEdge, type QueueCursor, type RecordN } from "../../src/host/queues.js";
import { encodeOps } from "../../src/log/record.js";
import { QueueWriter, type SegmentStore } from "../../src/log/queue-writer.js";
import { parseLogId, parseSegmentName } from "../../src/log/segment.js";
import type { AsyncFs } from "../../src/opfs/async-fs.js";
import { recoverQueues } from "../../src/recover.js";
import { manifestNumbers, readManifest } from "../../src/store/generation.js";
import { decodeSst } from "../../src/store/sst.js";
import { QueueFs, TestLocks, type Browser, type Fault } from "./queue-fs.js";

/**
 * Tabs whose dedicated WebWorkers append to per-tab logs with real
 * `QueueWriter`s, and a SharedWorker host that ingests and reclaims them
 * with the real `ingestQueues` and `reclaimQueues`, over one `QueueFs`.
 * The world keeps an oracle of what each writer acked, and checks the runs
 * against it once every tab is gone and the host has drained.
 *
 * `gate` is where a scheduler picks what runs next: before each of the
 * host's file-system calls and lock takes, and right after a writer
 * creates a segment file, so the host can list a segment whose header is
 * not written yet.
 */

/** A write or create the test file system fails, and the writer call that meets it. */
export type Attempt = { readonly fault: Fault; readonly via: "append" | "rotate" };

/** What a tab's page does next. */
export type TabCmd =
  | { readonly t: "append"; readonly count: number; readonly size: number }
  /** Flushes, and posts the flushed n to the host as its durable hint. */
  | { readonly t: "flush" }
  | { readonly t: "rotate" }
  /** On failure the tab starts a new log whose pred is the failed one, whose lock it keeps until `reap`. */
  | ({ readonly t: "fail" } & Attempt)
  | { readonly t: "reap" }
  /** The tab's dedicated WebWorker ends: closing its log, or killed, after a failure when `attempt` is set. */
  | { readonly t: "die"; readonly clean: boolean; readonly attempt?: Attempt }
  /** A dead tab loads again, with a fresh log. */
  | { readonly t: "reload" };

export type HostCmd = { readonly t: "ingest"; readonly maxBytes: number } | { readonly t: "reclaim" };

const writeFaultArb = (skip: fc.Arbitrary<number>): fc.Arbitrary<Fault> =>
  fc.record({
    at: fc.constant("write" as const),
    mode: fc.constantFrom("throw" as const, "short" as const),
    landed: fc.oneof(fc.nat({ max: 40 }), fc.constant(1 << 20)),
    skip,
  });

/** An append meets its fault in the record's write; a rotation in its first or second write, or its create. */
const attemptArb: fc.Arbitrary<Attempt> = fc.oneof(
  fc.record({ via: fc.constant("append" as const), fault: writeFaultArb(fc.constant(0)) }),
  fc.record({ via: fc.constant("rotate" as const), fault: fc.oneof(writeFaultArb(fc.constantFrom(0, 1)), fc.constant({ at: "create" as const })) }),
);

export const tabCmdArb: fc.Arbitrary<TabCmd> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ t: fc.constant("append" as const), count: fc.integer({ min: 1, max: 3 }), size: fc.nat({ max: 40 }) }) },
  { weight: 2, arbitrary: fc.constant({ t: "flush" as const }) },
  { weight: 2, arbitrary: fc.constant({ t: "rotate" as const }) },
  { weight: 2, arbitrary: attemptArb.map((a) => ({ t: "fail" as const, ...a })) },
  { weight: 2, arbitrary: fc.constant({ t: "reap" as const }) },
  {
    weight: 1,
    arbitrary: fc.record({ t: fc.constant("die" as const), clean: fc.boolean(), attempt: attemptArb }, { requiredKeys: ["t", "clean"] }),
  },
  { weight: 1, arbitrary: fc.constant({ t: "reload" as const }) },
);

export const hostCmdArb: fc.Arbitrary<HostCmd> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ t: fc.constant("ingest" as const), maxBytes: fc.constantFrom(1, 64, 256, Number.POSITIVE_INFINITY) }) },
  { weight: 1, arbitrary: fc.constant({ t: "reclaim" as const }) },
);

/** Segment sizes that hold about one, two and five records. */
export const segmentBytesArb = fc.constantFrom(96, 160, 400);

/** A seeded PRNG, so a failing history replays. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** How long a history may go with no task to release before it counts as stuck. */
const STUCK_MS = 10_000;

/**
 * Wait for `p`, releasing one scheduled task at a time, each after other
 * work had a few turns. Building a run takes macrotasks, and longer when
 * other test files share the CPU, so only a wall-clock wait with no task
 * to release means the history is stuck.
 */
export async function settle<T>(s: fc.Scheduler, p: Promise<T>): Promise<T> {
  let done = false;
  void p.then(
    () => (done = true),
    () => (done = true),
  );
  for (let idleSince = Date.now(); ; ) {
    for (let i = 0; i < 8; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    if (done) return p;
    if (s.count() > 0) {
      idleSince = Date.now();
      await s.waitOne();
    } else if (Date.now() - idleSince > STUCK_MS) throw new Error("harness: the history is stuck with no task to release");
  }
}

type Tab = { readonly id: string; writer: QueueWriter | undefined; log: LogId | undefined; abandoned: LogId[] };

/** What a log's writers acked, and the last record a failed write tried. */
type LogOracle = { readonly pred?: PredEdge; successor?: LogId; readonly acked: Map<RecordN, string>; readonly unacked: Map<RecordN, string> };

/** The database after a drain, as an outcome to compare across crash points: every record and every cursor. */
export type EndState = { readonly records: readonly string[]; readonly queues: readonly QueueCursor[] };

const enc = new TextEncoder();
const dec = new TextDecoder();

export class QueueWorld {
  readonly fs: QueueFs;
  readonly locks = new TestLocks();
  readonly hints = new Map<LogId, RecordN>();
  readonly logs = new Map<LogId, LogOracle>();
  /** Every `damagedLive` an ingest returned. */
  readonly damagedLive: LogId[] = [];
  private readonly tabs: Tab[];
  /** Each log's newest segment file. */
  private readonly newest = new Map<LogId, RecordN>();
  private readonly store: SegmentStore;
  gate: (label: string) => Promise<void> = async () => undefined;

  constructor(
    browser: Browser,
    private readonly random: () => number,
    tabs: number,
    private readonly segmentBytes: number,
    chromeRefusal = 1,
  ) {
    this.fs = new QueueFs(browser, random, chromeRefusal);
    this.tabs = Array.from({ length: tabs }, (_, i) => ({ id: `tab ${i}`, writer: undefined, log: undefined, abandoned: [] }));
    this.store = {
      create: async (log, firstN) => {
        const file = await this.fs.segments.create(log, firstN);
        this.newest.set(log, firstN);
        await this.gate(`${log} created segment ${firstN}`);
        return file;
      },
    };
  }

  /** The SharedWorker's view of the files and locks, each call through `gate`. */
  hostView(): { readonly fs: AsyncFs; readonly locks: LogLocks } {
    const gate = (label: string) => this.gate(label);
    return { fs: gatedFs(this.fs, gate), locks: gatedLocks(this.locks.for("host"), gate) };
  }

  async start(): Promise<void> {
    for (const tab of this.tabs) await this.open(tab);
  }

  private async open(tab: Tab, pred?: PredEdge): Promise<void> {
    let log: LogId;
    do log = Math.floor(this.random() * 2 ** 48).toString(16).padStart(16, "0") as LogId;
    while (this.logs.has(log));
    this.logs.set(log, { ...(pred && { pred }), acked: new Map(), unacked: new Map() });
    if (pred) this.logs.get(pred.log)!.successor = log;
    this.locks.hold(log, tab.id);
    tab.log = log;
    tab.writer = await QueueWriter.open(this.store, log, { segmentBytes: this.segmentBytes, ...(pred && { pred }) });
  }

  async run(i: number, cmd: TabCmd): Promise<void> {
    const tab = this.tabs[i]!;
    const { writer, log } = tab;
    if (cmd.t === "reload") {
      if (!writer) await this.open(tab);
      return;
    }
    if (!writer || !log) return;
    switch (cmd.t) {
      case "append": {
        const first = writer.lastAcked + 1;
        const values = Array.from({ length: cmd.count }, (_, k) => `${first + k}:${"x".repeat(cmd.size)}`);
        await writer.append(values.map((v, k) => body(log, first + k, v)));
        const { acked } = this.logs.get(log)!;
        values.forEach((v, k) => acked.set(first + k, v));
        return;
      }
      case "flush":
        this.hints.set(log, await writer.flush());
        return;
      case "rotate":
        await writer.rotate();
        return;
      case "reap":
        for (const l of tab.abandoned) this.locks.release(l);
        tab.abandoned = [];
        return;
      case "fail":
        if (await this.attempt(writer, log, cmd)) {
          tab.abandoned.push(log);
          await this.open(tab, { log, lastN: writer.lastAcked });
        }
        return;
      case "die":
        if (cmd.attempt) await this.attempt(writer, log, cmd.attempt);
        if (cmd.clean) await writer.close();
        for (const l of [log, ...tab.abandoned]) this.fs.closeHandles(l);
        this.locks.releaseAll(tab.id);
        Object.assign(tab, { writer: undefined, log: undefined, abandoned: [] });
        return;
    }
  }

  /** True when the writer failed. */
  private async attempt(writer: QueueWriter, log: LogId, { fault, via }: Attempt): Promise<boolean> {
    const oracle = this.logs.get(log)!;
    const n = writer.lastAcked + 1;
    const value = `${n}:tried`;
    this.fs.fail(log, fault);
    try {
      if (via === "rotate") await writer.rotate();
      else {
        await writer.append([body(log, n, value)]);
        oracle.acked.set(n, value);
      }
      return false;
    } catch {
      if (via === "append") oracle.unacked.set(n, value);
      return true;
    } finally {
      this.fs.disarm(log);
    }
  }

  async serve(cmd: HostCmd, host = this.hostView()): Promise<void> {
    if (cmd.t === "reclaim") return reclaimQueues(host.fs, host.locks);
    const out = await ingestQueues(host.fs, host.locks, this.hints, cmd.maxBytes);
    if (out.kind === "ingested") this.damagedLive.push(...out.damagedLive);
  }

  /**
   * What reclaim promises between host commands: every manifest on disk
   * finds its records, so recovery can stand on whichever one a crash
   * leaves newest; no live log lost its newest segment; and a log whose
   * directory is gone is final in each of the newest RECLAIM_LAG + 1
   * manifests. Files are snapshot in one step, since tabs go on writing.
   */
  async checkFiles(): Promise<void> {
    const logs = logsIn(this.fs.paths());
    const live = this.tabs.flatMap((t) => (t.log ? [t.log, ...t.abandoned] : t.abandoned));
    const newest = new Map(this.newest);
    expect(this.fs.removedLast, "removed a live log's last segment").toEqual([]);
    const onDisk = new Map(logs.map((l) => [l.log, l.segments]));
    for (const log of live) if (newest.has(log)) expect(onDisk.get(log), `live log ${log}'s newest segment`).toContain(newest.get(log));
    const manifests: (readonly QueueCursor[])[] = [];
    for (const g of await manifestNumbers(this.fs)) {
      const meta = await readManifest(this.fs, g);
      if (!meta) continue;
      expect(checkCover(meta.queues ?? [], logs), `manifest ${g} cannot find its records`).toBeUndefined();
      manifests.push(meta.queues ?? []);
    }
    for (const log of newest.keys()) {
      if (onDisk.has(log)) continue;
      for (const queues of manifests.slice(0, RECLAIM_LAG + 1)) {
        expect(queues.find((c) => c.log === log)?.state, `${log}'s directory is gone`).toBe("final");
      }
    }
  }

  /** Every tab's dedicated WebWorker ends, then the host ingests until nothing changes, and reclaims. */
  async drain(): Promise<void> {
    this.gate = async () => undefined;
    for (let i = 0; i < this.tabs.length; i++) await this.run(i, { t: "die", clean: true });
    for (let round = 0, before = -1; ; round++) {
      const { generation } = await ingestQueues(this.fs, this.locks.for("host"), this.hints, Number.POSITIVE_INFINITY);
      if (generation === before) break;
      if (round > 20) throw new Error("harness: the drain does not settle");
      before = generation;
    }
    await reclaimQueues(this.fs, this.locks.for("host"));
  }

  /**
   * The runs of the manifest recovery opens, against the oracle: seqs 1 to
   * through, each once; every acked record once, with its value; nothing a
   * writer did not ack, except the last try of a log no successor caps;
   * each log in n order and after its pred; every log final.
   */
  async checkRuns(): Promise<EndState> {
    const { base } = await recoverQueues(this.fs);
    const records = new Map<LogId, { n: RecordN; seq: number; value: string }[]>();
    const seqs: number[] = [];
    for (const run of base.runs) {
      for (const e of decodeSst((await this.fs.read(run.path, 0, Number.POSITIVE_INFINITY))!)) {
        const [log, n] = dec.decode(e.key).split("/") as [LogId, string];
        const got = records.get(log) ?? [];
        records.set(log, got);
        expect(got.some((r) => r.n === Number(n)), `${log}/${n} is in two runs`).toBe(false);
        got.push({ n: Number(n), seq: e.seq!, value: e.kind === "put" ? dec.decode(e.value) : "" });
        seqs.push(e.seq!);
      }
    }
    expect(seqs.sort((a, b) => a - b), "seqs").toEqual(Array.from({ length: base.through }, (_, i) => i + 1));
    expect(this.damagedLive, "damaged live logs").toEqual([]);
    for (const [log, oracle] of this.logs) {
      const got = (records.get(log) ?? []).sort((a, b) => a.n - b.n);
      for (const [n, value] of oracle.acked) expect(got.find((r) => r.n === n)?.value, `acked ${log}/${n}`).toBe(value);
      for (const r of got) {
        const allowed = oracle.acked.get(r.n) ?? (oracle.successor ? undefined : oracle.unacked.get(r.n));
        expect(r.value, `${log}/${r.n} was ingested but never acked`).toBe(allowed);
      }
      got.forEach((r, i) => i > 0 && expect(r.seq, `${log}/${r.n} after ${log}/${got[i - 1]!.n}`).toBeGreaterThan(got[i - 1]!.seq));
      if (oracle.pred && got.length > 0) {
        const pred = records.get(oracle.pred.log) ?? [];
        expect(Math.max(0, ...pred.map((r) => r.seq)), `${oracle.pred.log} before its successor ${log}`).toBeLessThan(got[0]!.seq);
      }
      if (this.newest.has(log)) expect(base.queues?.find((c) => c.log === log)?.state, `${log}'s cursor`).toBe("final");
    }
    const all = [...records].flatMap(([log, rs]) => rs.map((r) => `${log}/${r.n}=${r.value}`)).sort();
    return { records: all, queues: base.queues ?? [] };
  }
}

/** The per-tab logs in `paths`, as `listLogs` reads them. */
function logsIn(paths: readonly string[]): LogFiles[] {
  const logs = new Map<LogId, RecordN[]>();
  for (const path of paths) {
    const [top, dir, name] = path.split("/");
    const log = dir === undefined ? undefined : parseLogId(dir);
    const firstN = name === undefined ? undefined : parseSegmentName(name);
    if (top !== "w" || !log || firstN === undefined) continue;
    logs.set(log, [...(logs.get(log) ?? []), firstN]);
  }
  return [...logs].map(([log, segments]) => ({ log, segments: segments.sort((a, b) => a - b) }));
}

function body(log: LogId, n: RecordN, value: string): Uint8Array {
  return encodeOps([{ type: "put", key: enc.encode(`${log}/${n}`) as CheckedKey, value: enc.encode(value) as CheckedValue }]);
}

function gatedFs(fs: AsyncFs, gate: (label: string) => Promise<void>): AsyncFs {
  const at = async <T>(label: string, call: () => Promise<T>): Promise<T> => {
    await gate(label);
    return call();
  };
  return {
    read: (path, offset, length) => at(`read ${path}`, () => fs.read(path, offset, length)),
    open: (path) => at(`open ${path}`, () => fs.open(path)),
    list: (dir) => at(`list ${dir}`, () => fs.list(dir)),
    remove: (path) => at(`remove ${path}`, () => fs.remove(path)),
    removeUnlessOpen: (path) => at(`remove ${path}`, () => fs.removeUnlessOpen(path)),
    create: (path) => at(`create ${path}`, () => fs.create(path)),
  };
}

function gatedLocks(locks: LogLocks, gate: (label: string) => Promise<void>): LogLocks {
  return {
    take: async (log) => {
      await gate(`take ${log}'s lock`);
      return locks.take(log);
    },
  };
}

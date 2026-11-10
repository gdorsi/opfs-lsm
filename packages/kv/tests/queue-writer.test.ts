import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { CheckedKey, CheckedOp, CheckedValue } from "../src/check.js";
import { ClosedError, CommitError } from "../src/errors.js";
import { planIngest, type LogId, type QueueScan } from "../src/host/queues.js";
import { encodeOps } from "../src/idb/wal.js";
import { scanLog, type ListedSegment } from "../src/log/queue-scan.js";
import { QueueWriter, type QueueWriterOptions, type SegmentFile, type SegmentStore } from "../src/log/queue-writer.js";
import { encodeRecords, encodeSeal, FRAME_HEAD_BYTES, frameSeed, HEADER_BYTES } from "../src/log/segment.js";

const LOG = "00000000000000b2" as LogId;
const NEXT = "00000000000000c3" as LogId;

const opsOf = (n: number, value: Uint8Array = Uint8Array.of(n, n)): CheckedOp[] => [
  { type: "put", key: Uint8Array.of(n & 0xff) as CheckedKey, value: value as CheckedValue },
];
const body = (ops: readonly CheckedOp[]): Uint8Array => new Uint8Array(encodeOps(ops));
const range = (lo: number, hi: number): number[] => Array.from({ length: Math.max(0, hi - lo + 1) }, (_, i) => lo + i);
const ns = (scan: QueueScan): number[] => scan.records.map((r) => r.n);
const counter = (): (() => number) => {
  let next = 1000;
  return () => next++;
};

/** For a write: how many bytes land, and whether the call then throws or returns that short count. */
type Fault = { readonly mode: "throw" | "short"; readonly landed: number };

class MemFile implements SegmentFile {
  bytes = new Uint8Array(0);
  closed = false;

  constructor(
    private readonly store: MemStore,
    private readonly label: string,
  ) {}

  write(data: Uint8Array, at: number): number {
    const fault = this.store.io(`write ${this.label}`);
    if (this.closed) throw new Error("write to a closed handle");
    const landed = fault ? Math.min(fault.landed, data.length) : data.length;
    if (at + landed > this.bytes.length) {
      const grown = new Uint8Array(at + landed);
      grown.set(this.bytes);
      this.bytes = grown;
    }
    this.bytes.set(data.subarray(0, landed), at);
    if (fault?.mode === "throw") throw new Error("injected write failure");
    return landed;
  }

  flush(): void {
    if (this.store.io(`flush ${this.label}`)) throw new Error("injected flush failure");
    if (this.closed) throw new Error("flush of a closed handle");
  }

  close(): void {
    this.closed = true;
    if (this.store.io(`close ${this.label}`)) throw new Error("injected close failure");
  }
}

class MemStore implements SegmentStore {
  readonly calls: string[] = [];
  readonly files = new Map<LogId, Map<number, MemFile>>();
  /** Fails the I/O call with this index in `calls`. */
  failAt: { index: number; fault: Fault } | undefined;
  /** The dedicated WebWorker dies once this many I/O calls are done: no later call happens. */
  stopAfter = Infinity;
  fired = false;
  private next: { label: string; fault: Fault } | undefined;

  io(label: string): Fault | undefined {
    if (this.calls.length >= this.stopAfter) throw new Error("the dedicated WebWorker is gone");
    this.calls.push(label);
    let fault: Fault | undefined;
    if (this.failAt?.index === this.calls.length - 1) fault = this.failAt.fault;
    if (this.next?.label === label) [fault, this.next] = [this.next.fault, undefined];
    if (fault) this.fired = true;
    return fault;
  }

  failNext(label: string, fault: Fault = { mode: "throw", landed: 0 }): void {
    this.next = { label, fault };
  }

  async create(log: LogId, firstN: number): Promise<SegmentFile> {
    const label = log === LOG ? String(firstN) : `${log}/${firstN}`;
    if (this.io(`create ${label}`)) throw new Error("injected create failure");
    const file = new MemFile(this, label);
    if (!this.files.has(log)) this.files.set(log, new Map());
    this.files.get(log)!.set(firstN, file);
    return file;
  }

  listing(log: LogId): ListedSegment[] {
    return [...(this.files.get(log) ?? [])].map(([firstN, f]) => ({ firstN, bytes: f.bytes.slice() }));
  }

  size(log: LogId, firstN: number): number {
    return this.files.get(log)!.get(firstN)!.bytes.length;
  }
}

async function openWriter(store: MemStore, options: Partial<QueueWriterOptions> = {}, log = LOG): Promise<QueueWriter> {
  // A typed binding: fallow does not follow the static factory's return type to the members tests call.
  const writer: QueueWriter = await QueueWriter.open(store, log, { segmentBytes: 1024, nonce: counter(), ...options });
  return writer;
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error("expected a rejection");
    },
    (err: unknown) => err,
  );
}

/** Opens a log, then runs one rotate() and one size-triggered rotation, up to the first call that rejects. */
async function rotations(store: MemStore): Promise<{ writer?: QueueWriter; acked: CheckedOp[][]; rejected: boolean }> {
  const acked: CheckedOp[][] = [];
  let writer: QueueWriter;
  try {
    writer = await openWriter(store, { segmentBytes: HEADER_BYTES + 2 * (FRAME_HEAD_BYTES + body(opsOf(1)).length) });
  } catch {
    return { acked, rejected: true };
  }
  const steps: (readonly number[] | "rotate" | "flush")[] = [[1, 2], "rotate", [3], [4], [5], "flush"];
  for (const step of steps) {
    try {
      if (step === "rotate") await writer.rotate();
      else if (step === "flush") await writer.flush();
      else {
        const ops = step.map((n) => opsOf(n));
        await writer.append(ops.map(body));
        acked.push(...ops);
      }
    } catch {
      return { writer, acked, rejected: true };
    }
  }
  return { writer, acked, rejected: false };
}

/** The disk reads back exactly the acked records from every cursor and ends there, live or dead, and the dead log plans final. */
function expectWhole(store: MemStore, acked: readonly CheckedOp[][], at: string): void {
  const listed = store.listing(LOG);
  for (const dead of [false, true]) {
    for (let from = 0; from <= acked.length; from++) {
      const scan = scanLog(LOG, from, dead, listed);
      const want = acked.slice(from).map((ops, i) => [from + 1 + i, ops]);
      const where = `${at}, ${dead ? "dead" : "live"} from ${from}`;
      expect([where, scan.stop, scan.records.map((r) => [r.n, r.ops])]).toEqual([where, "end", want]);
    }
  }
  const plan = planIngest({ through: 0, queues: [] }, [scanLog(LOG, 0, true, listed)], new Map(), Infinity);
  expect([at, plan.queues]).toEqual([at, [{ log: LOG, state: "final", n: acked.length }]]);
}

describe("QueueWriter", () => {
  it("flushes the first header, with its pred, before it resolves open", async () => {
    const store = new MemStore();
    await openWriter(store, { pred: { log: LOG, lastN: 3 } }, NEXT);
    expect(store.calls).toEqual([`create ${NEXT}/1`, `write ${NEXT}/1`, `flush ${NEXT}/1`]);
    expect(scanLog(NEXT, 0, false, store.listing(NEXT))).toEqual({ log: NEXT, dead: false, pred: { log: LOG, lastN: 3 }, records: [], stop: "end" });
  });

  it("flushes a segment and the successor's header before it seals, flushes and closes the old one, and before any frame of the successor", async () => {
    const store = new MemStore();
    const writer = await openWriter(store);
    await writer.append([body(opsOf(1))]);
    await writer.rotate();
    await writer.append([body(opsOf(2))]);
    expect(store.calls).toEqual([
      "create 1", "write 1", "flush 1",
      "write 1",
      "flush 1", "create 2", "write 2", "flush 2", "write 1", "flush 1", "close 1",
      "write 2",
    ]);
  });

  it("returns every acked record from any cursor, across rotations and seals, live or dead", async () => {
    const store = new MemStore();
    const segmentBytes = 160;
    const writer = await openWriter(store, { segmentBytes });
    const acked: CheckedOp[][] = [];
    const sizes = [[3], [40, 1], [0], [70], [5, 5, 5], [200], [9], [30, 30]];
    for (const [i, batch] of sizes.entries()) {
      const ops = batch.map((s, k) => opsOf(acked.length + 1 + k, new Uint8Array(s).fill(i)));
      expect(await writer.append(ops.map(body))).toBe(acked.length + ops.length);
      acked.push(...ops);
      if (i === 2) await writer.rotate();
    }
    expect(await writer.flush()).toBe(acked.length);
    const listed = store.listing(LOG);
    expect(listed.length).toBeGreaterThan(3);
    for (const s of listed) {
      if ((s.bytes as Uint8Array).length > segmentBytes + 13) expect(scanLog(LOG, s.firstN - 1, false, [s]).records).toHaveLength(1);
    }
    for (const dead of [false, true]) {
      for (let from = 0; from <= acked.length; from++) {
        const reclaimed = listed.filter((s, i) => i === listed.length - 1 || listed[i + 1]!.firstN - 1 > from);
        for (const segs of [listed, reclaimed]) {
          const scan = scanLog(LOG, from, dead, segs);
          expect(scan.records.map((r) => [r.n, r.ops])).toEqual(acked.slice(from).map((ops, i) => [from + 1 + i, ops]));
          expect(scan.stop).toBe("end");
        }
      }
    }
  });

  it("runs calls one at a time in call order", async () => {
    const store = new MemStore();
    const writer = await openWriter(store, { segmentBytes: 64 });
    const calls = range(1, 30).map((n) => (n % 7 === 0 ? writer.rotate().then(() => 0) : writer.append([body(opsOf(n))])));
    const acked = (await Promise.all(calls)).filter((n) => n > 0);
    expect(acked).toEqual(range(1, acked.length));
    expect(ns(scanLog(LOG, 0, false, store.listing(LOG)))).toEqual(acked);
  });

  it("leaves a segment with no record open on rotate", async () => {
    const store = new MemStore();
    const writer = await openWriter(store);
    await writer.rotate();
    await writer.append([body(opsOf(1))]);
    await writer.rotate();
    await writer.rotate();
    expect(store.listing(LOG).map((s) => s.firstN)).toEqual([1, 2]);
  });

  it("closes without sealing, so the dead log reads to its end, and refuses calls after", async () => {
    const store = new MemStore();
    const writer = await openWriter(store);
    await writer.append([body(opsOf(1)), body(opsOf(2))]);
    await writer.close();
    await writer.close();
    expect(store.calls.slice(-2)).toEqual(["flush 1", "close 1"]);
    const scan = scanLog(LOG, 0, true, store.listing(LOG));
    expect([ns(scan), scan.stop]).toEqual([[1, 2], "end"]);
    expect(await rejection(writer.append([body(opsOf(3))]))).toBeInstanceOf(ClosedError);
  });

  describe("across rotations", () => {
    it("leaves every acked record readable and no hole when the dedicated WebWorker dies after any call", async () => {
      const clean = new MemStore();
      await rotations(clean);
      expect(clean.listing(LOG).map((s) => s.firstN)).toEqual([1, 3, 5]);
      for (let k = 0; k <= clean.calls.length; k++) {
        const store = new MemStore();
        store.stopAfter = k;
        const { writer, acked } = await rotations(store);
        expect(writer?.lastAcked ?? 0).toBe(acked.length);
        expectWhole(store, acked, `dies after ${k} calls, the last ${clean.calls[k - 1] ?? "none"}`);
      }
    });

    it("goes terminal with the right lastAcked, closes every file and leaves no hole when any call fails", async () => {
      const clean = new MemStore();
      await rotations(clean);
      for (let k = 0; k < clean.calls.length; k++) {
        for (const fault of [{ mode: "throw", landed: 0 }, { mode: "short", landed: 5 }] as const) {
          const at = `${fault.mode} at call ${k}, ${clean.calls[k]}`;
          const store = new MemStore();
          store.failAt = { index: k, fault };
          const { writer, acked, rejected } = await rotations(store);
          expect([at, rejected]).toEqual([at, true]);
          if (writer) {
            expect([at, writer.lastAcked]).toEqual([at, acked.length]);
            const calls = store.calls.length;
            for (const later of [writer.append([body(opsOf(9))]), writer.flush(), writer.rotate()]) {
              expect(await rejection(later)).toBeInstanceOf(CommitError);
            }
            expect(store.calls.length).toBe(calls);
          }
          const open = [...(store.files.get(LOG)?.entries() ?? [])].filter(([, f]) => !f.closed).map(([n]) => n);
          expect([at, "segments left open", open]).toEqual([at, "segments left open", []]);
          expectWhole(store, acked, at);
        }
      }
    });

    it("reads a dead log whose successor file is gone after a finished rotation as a hole", async () => {
      const store = new MemStore();
      const writer = await openWriter(store);
      await writer.append([body(opsOf(1))]);
      await writer.rotate();
      const lost = store.listing(LOG).filter((s) => s.firstN !== 2);
      expect(scanLog(LOG, 0, false, lost).stop).toBe("partial");
      const dead = scanLog(LOG, 0, true, lost);
      expect([ns(dead), dead.stop]).toEqual([[1], { hole: 2, reason: "sealed segment has no successor" }]);
      expect(planIngest({ through: 0, queues: [] }, [dead], new Map(), Infinity).queues).toEqual([
        { log: LOG, state: "damaged", n: 1, reason: "sealed segment has no successor" },
      ]);
    });
  });

  describe("after a failed write", () => {
    async function failing(fault: Fault): Promise<{ store: MemStore; writer: QueueWriter; err: unknown }> {
      const store = new MemStore();
      const writer = await openWriter(store);
      await writer.append([body(opsOf(1)), body(opsOf(2))]);
      store.failNext("write 1", fault);
      const err = await rejection(writer.append([body(opsOf(3)), body(opsOf(4))]));
      return { store, writer, err };
    }

    it("goes terminal: reports the last acked n, refuses every later call, and touches no file again", async () => {
      for (const fault of [{ mode: "throw", landed: 0 }, { mode: "short", landed: 5 }] as const) {
        const { store, writer, err } = await failing(fault);
        expect(err).toBeInstanceOf(fault.mode === "short" ? CommitError : Error);
        expect(writer.lastAcked).toBe(2);
        const calls = store.calls.length;
        for (const later of [writer.append([body(opsOf(5))]), writer.flush(), writer.rotate()]) {
          expect(await rejection(later)).toBeInstanceOf(CommitError);
        }
        await writer.close();
        expect(store.calls.length).toBe(calls);
        for (const dead of [false, true]) {
          const scan = scanLog(LOG, 0, dead, store.listing(LOG));
          expect([ns(scan), scan.stop]).toEqual([[1, 2], "end"]);
        }
      }
    });

    it("lets the scan return a failed write's whole frames, which only the successor's pred keeps out of ingest", async () => {
      const frame3 = 13 + body(opsOf(3)).length;
      for (const fault of [{ mode: "throw", landed: 1_000 }, { mode: "short", landed: frame3 + 4 }] as const) {
        const { store, writer } = await failing(fault);
        const old = scanLog(LOG, 0, true, store.listing(LOG));
        expect([ns(old), old.stop]).toEqual([fault.mode === "throw" ? [1, 2, 3, 4] : [1, 2, 3], "end"]);

        const next = await openWriter(store, { pred: { log: LOG, lastN: writer.lastAcked } }, NEXT);
        await next.append([body(opsOf(9))]);
        const plan = planIngest({ through: 0, queues: [] }, [old, scanLog(NEXT, 0, false, store.listing(NEXT))], new Map([[NEXT, 1]]), Infinity);
        expect(plan.records.map((r) => `${r.log === LOG ? "old" : "next"}${r.n}`)).toEqual(["old1", "old2", "next1"]);
        expect(plan.queues).toContainEqual({ log: LOG, state: "final", n: 2 });
      }
    });

    it("reads a log whose successor's create failed to its end, live or dead, and plans it final", async () => {
      const store = new MemStore();
      const writer = await openWriter(store);
      await writer.append([body(opsOf(1))]);
      store.failNext("create 2");
      await rejection(writer.rotate());
      expect(writer.lastAcked).toBe(1);
      for (const dead of [false, true]) {
        const scan = scanLog(LOG, 0, dead, store.listing(LOG));
        expect([ns(scan), scan.stop]).toEqual([[1], "end"]);
      }
      expect(planIngest({ through: 0, queues: [] }, [scanLog(LOG, 0, true, store.listing(LOG))], new Map(), Infinity).queues).toEqual([
        { log: LOG, state: "final", n: 1 },
      ]);
    });
  });

  it("never returns a cut record or reports a hole for a torn tail, at every byte offset, with frame-shaped values", async () => {
    const store = new MemStore();
    const writer = await openWriter(store, { segmentBytes: 4096 });
    const acked: { n: number; ops: CheckedOp[]; end: number }[] = [];
    const add = async (value: Uint8Array): Promise<void> => {
      const n = acked.length + 1;
      await writer.append([body(opsOf(n, value))]);
      acked.push({ n, ops: opsOf(n, value), end: store.size(LOG, 3) });
    };
    await writer.append([body(opsOf(1))]);
    await writer.append([body(opsOf(2))]);
    acked.push({ n: 1, ops: opsOf(1), end: 0 }, { n: 2, ops: opsOf(2), end: 0 });
    await writer.rotate();

    const otherSeed = frameSeed(0xdead_beef);
    await add(Uint8Array.of(7, 7, 7));
    const ownFrame = store.files.get(LOG)!.get(3)!.bytes.slice(32);
    await add(encodeRecords([body(opsOf(6)), body(opsOf(7))], 6, otherSeed));
    const twoOwn = store.files.get(LOG)!.get(3)!.bytes.slice(32);
    await add(new Uint8Array([...ownFrame, 1, 2, ...encodeSeal(9, otherSeed)]));
    await add(new Uint8Array([...twoOwn, ...encodeRecords([body(opsOf(8))], 8, otherSeed)]));
    await add(Uint8Array.of(9));

    const [first, last] = store.listing(LOG) as [ListedSegment, ListedSegment];
    const tail = last.bytes as Uint8Array;
    let cuts = 0;
    for (let c = 0; c <= tail.length; c++) {
      for (const dead of [false, true]) {
        for (const from of [0, 2, 4]) {
          const scan = scanLog(LOG, from, dead, [first, { firstN: 3, bytes: tail.subarray(0, c) }]);
          const whole = acked.filter((r) => r.n > from && r.end <= c);
          expect(scan.records.map((r) => [r.n, r.ops])).toEqual(whole.map((r) => [r.n, r.ops]));
          expect(scan.stop).toBe("end");
          cuts++;
        }
      }
    }
    expect(cuts).toBe((tail.length + 1) * 6);
    console.log(`torn-tail sweep: ${tail.length + 1} cut offsets of a ${tail.length}-byte last segment, ${cuts} scans`);
  });

  it("can be made to report a hole in a dead log's torn tail only by a value that forges a later frame of its own segment", async () => {
    const store = new MemStore();
    const writer = await openWriter(store, { segmentBytes: 4096, nonce: () => 42 });
    await writer.append([body(opsOf(1))]);
    const forged = encodeRecords([body(opsOf(3))], 3, frameSeed(42));
    await writer.append([body(opsOf(2, new Uint8Array([...forged, 0, 0])))]);
    const bytes = store.listing(LOG)[0]!.bytes as Uint8Array;
    const torn = [{ firstN: 1, bytes: bytes.subarray(0, bytes.length - 1) }];
    expect(scanLog(LOG, 0, false, torn).stop).toBe("end");
    expect(scanLog(LOG, 0, true, torn).stop).toEqual({ hole: 2, reason: "bad frame" });
  });

  it("matches a model of acked records over random appends, rotations, flushes and failures", async () => {
    type Cmd =
      | { readonly kind: "append"; readonly sizes: readonly number[] }
      | { readonly kind: "rotate" }
      | { readonly kind: "flush" }
      | { readonly kind: "fault"; readonly after: number; readonly fault: Fault };
    const cmd: fc.Arbitrary<Cmd> = fc.oneof(
      { arbitrary: fc.record({ kind: fc.constant("append" as const), sizes: fc.array(fc.nat(48), { maxLength: 3 }) }), weight: 6 },
      { arbitrary: fc.constant({ kind: "rotate" as const }), weight: 1 },
      { arbitrary: fc.constant({ kind: "flush" as const }), weight: 1 },
      {
        arbitrary: fc.record({
          kind: fc.constant("fault" as const),
          after: fc.nat(3),
          fault: fc.record({ mode: fc.constantFrom("throw" as const, "short" as const), landed: fc.nat(160) }),
        }),
        weight: 1,
      },
    );
    await fc.assert(
      fc.asyncProperty(fc.array(cmd, { maxLength: 30 }), fc.integer({ min: 48, max: 320 }), fc.nat(), async (cmds, segmentBytes, pick) => {
        const store = new MemStore();
        const writer = await openWriter(store, { segmentBytes });
        const acked: CheckedOp[][] = [];
        let attempted: CheckedOp[][] = [];
        let failedAt: number | undefined;
        for (const c of cmds) {
          if (c.kind === "fault") {
            store.failAt = { index: store.calls.length + c.after, fault: c.fault };
            continue;
          }
          const ops = c.kind === "append" ? c.sizes.map((s, i) => opsOf(acked.length + 1 + i, new Uint8Array(s).fill(s))) : [];
          const call = c.kind === "append" ? writer.append(ops.map(body)) : c.kind === "rotate" ? writer.rotate() : writer.flush();
          try {
            const r = await call;
            expect(failedAt).toBeUndefined();
            if (c.kind !== "rotate") expect(r).toBe(acked.length + ops.length);
            acked.push(...ops);
          } catch {
            if (failedAt === undefined) {
              expect(store.fired).toBe(true);
              attempted = ops;
              failedAt = store.calls.length;
            }
          }
          expect(writer.lastAcked).toBe(acked.length);
        }
        if (failedAt !== undefined) expect(store.calls.length).toBe(failedAt);

        const n = acked.length;
        for (const dead of [false, true]) {
          for (const from of [0, pick % (n + 1), n]) {
            const listed = store.listing(LOG);
            const reclaimed = listed.filter((s, i) => i === listed.length - 1 || listed[i + 1]!.firstN - 1 > from);
            for (const segs of [listed, reclaimed]) {
              const scan = scanLog(LOG, from, dead, segs);
              const got = scan.records.map((r) => r.ops);
              expect(ns(scan)).toEqual(range(from + 1, from + got.length));
              expect(got.slice(0, n - from)).toEqual(acked.slice(from));
              expect(got.slice(n - from)).toEqual(attempted.slice(0, got.length - (n - from)));
              expect(scan.stop).toBe("end");
            }
          }
        }
      }),
      { numRuns: 400 },
    );
  });
});

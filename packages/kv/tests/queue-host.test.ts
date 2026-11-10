import { describe, expect, it } from "vitest";
import type { CheckedKey, CheckedValue } from "../src/check.js";
import { CorruptDatabaseError } from "../src/errors.js";
import { scanQueues } from "../src/host/queue-host.js";
import type { LogId, PredEdge, QueueCursor, QueueScan } from "../src/host/queues.js";
import { encodeOps } from "../src/idb/wal.js";
import { QueueWriter } from "../src/log/queue-writer.js";
import { segmentPath } from "../src/log/segment.js";
import type { AsyncFs } from "../src/opfs/async-fs.js";
import { MemoryFs } from "../src/opfs/memory-fs.js";
import { recoverQueues } from "../src/recover.js";
import { listLogs, publishGeneration, publishRun } from "../src/store/generation.js";
import { BROWSERS, QueueFs, TestLocks, type Browser } from "./sim/queue-fs.js";

const A = "00000000000000a1" as LogId;
const B = "00000000000000b2" as LogId;
const enc = new TextEncoder();

const body = (log: LogId, n: number): Uint8Array =>
  new Uint8Array(encodeOps([{ type: "put", key: enc.encode(`${log}/${n}`) as CheckedKey, value: enc.encode(`value ${n}`) as CheckedValue }]));
const ns = (scan: QueueScan | undefined): number[] => scan?.records.map((r) => r.n) ?? [];
const range = (lo: number, hi: number): number[] => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);

/** A writer of `log` that holds its lock, with room for about `perSegment` records a segment. */
async function startLog(fs: QueueFs, locks: TestLocks, log: LogId, perSegment = 100, pred?: PredEdge): Promise<QueueWriter> {
  locks.hold(log, log);
  return QueueWriter.open(fs.segments, log, { segmentBytes: 32 + perSegment * (13 + body(log, 1).byteLength), ...(pred && { pred }) });
}

async function append(w: QueueWriter, log: LogId, count: number): Promise<void> {
  for (let i = 0; i < count; i++) await w.append([body(log, w.lastAcked + 1)]);
}

async function scan(fs: AsyncFs, locks: TestLocks, queues: QueueCursor[] = []): Promise<QueueScan[]> {
  return scanQueues(fs, locks.for("host"), queues, await listLogs(fs), async (scans) => scans);
}

async function file(fs: MemoryFs, path: string, bytes = new Uint8Array([1])): Promise<void> {
  await publishRun(fs, path, bytes);
}

async function manifest(fs: MemoryFs, generation: number, queues: QueueCursor[], runs: string[] = []): Promise<void> {
  for (const path of runs) await file(fs, path);
  await publishGeneration(fs, { generation, runs: runs.map((path) => ({ path, bytes: 1 })), tombstoneSeq: 0, through: 0, queues });
}

describe("recoverQueues", () => {
  it("builds on the newest manifest whose runs are all there, past an empty one and one whose run is gone", async () => {
    const fs = new MemoryFs();
    await manifest(fs, 1, [{ log: A, state: "open", n: 3 }], ["l0/1-3.sst"]);
    await manifest(fs, 2, [{ log: A, state: "open", n: 5 }], ["l0/4-5.sst"]);
    await fs.remove("l0/4-5.sst");
    await file(fs, "m/0000000000000003.mft", new Uint8Array(0));
    await file(fs, segmentPath(A, 1));

    const got = await recoverQueues(fs);
    expect(got.base.generation).toBe(1);
    expect(got.base.queues).toEqual([{ log: A, state: "open", n: 3 }]);
    expect(got.top).toBe(3);
    expect(got.logs).toEqual([{ log: A, segments: [1] }]);
  });

  it("opens an empty database and one whose logs start at their first record", async () => {
    expect((await recoverQueues(new MemoryFs())).base.generation).toBe(0);
    const fs = new MemoryFs();
    await file(fs, segmentPath(A, 1));
    await file(fs, segmentPath(A, 9));
    expect((await recoverQueues(fs)).logs).toEqual([{ log: A, segments: [1, 9] }]);
  });

  it("refuses when an open cursor's log is gone", async () => {
    const fs = new MemoryFs();
    await manifest(fs, 1, [{ log: A, state: "open", n: 3 }]);
    await expect(recoverQueues(fs)).rejects.toThrow(CorruptDatabaseError);
  });

  it("refuses when a log's first segment starts past the record after its cursor", async () => {
    const fs = new MemoryFs();
    await manifest(fs, 1, [{ log: A, state: "open", n: 3 }]);
    await file(fs, segmentPath(A, 6));
    await expect(recoverQueues(fs)).rejects.toThrow(CorruptDatabaseError);
  });

  it("refuses a log that starts past record 1 when no manifest has a cursor for it", async () => {
    const fs = new MemoryFs();
    await file(fs, segmentPath(B, 4));
    await expect(recoverQueues(fs)).rejects.toThrow(CorruptDatabaseError);
  });

  it("opens past a final log whose segments are gone", async () => {
    const fs = new MemoryFs();
    await manifest(fs, 1, [{ log: A, state: "final", n: 8 }]);
    await file(fs, segmentPath(A, 7));
    expect((await recoverQueues(fs)).base.generation).toBe(1);
  });

  it("refuses a newest manifest that does not decode", async () => {
    const fs = new MemoryFs();
    await manifest(fs, 1, []);
    await file(fs, "m/0000000000000002.mft", new Uint8Array([1, 2, 3, 4]));
    await expect(recoverQueues(fs)).rejects.toThrow(CorruptDatabaseError);
  });
});

describe("scanQueues", () => {
  it.each(BROWSERS)("%s: reads a dead log to its end and holds its lock until the scans are used", async (browser) => {
    const fs = new QueueFs(browser);
    const locks = new TestLocks();
    const w = await startLog(fs, locks, A, 2);
    await append(w, A, 5);
    await w.close();
    locks.release(A);

    const scans = await scanQueues(fs, locks.for("host"), [], await listLogs(fs), async (scans) => {
      expect(locks.heldBy(A)).toBe("host");
      return scans;
    });
    expect(scans).toMatchObject([{ log: A, dead: true, stop: "end" }]);
    expect(ns(scans[0])).toEqual(range(1, 5));
    expect(locks.heldBy(A)).toBeUndefined();
  });

  const live: Record<Browser, { records: number[]; stop: QueueScan["stop"] }> = {
    chrome: { records: [], stop: "partial" },
    safari: { records: range(1, 3), stop: "end" },
    firefox: { records: range(1, 4), stop: "end" },
  };
  it.each(BROWSERS)("%s: reads a live log no further than the browser shows it", async (browser) => {
    const fs = new QueueFs(browser, () => 0.5);
    const locks = new TestLocks();
    const w = await startLog(fs, locks, A);
    await append(w, A, 3);
    await w.flush();
    await append(w, A, 2);

    const [got] = await scan(fs, locks);
    expect(got).toMatchObject({ log: A, dead: false, stop: live[browser].stop });
    expect(ns(got)).toEqual(live[browser].records);
    expect(locks.heldBy(A)).toBe(A);
  });

  it.each(BROWSERS)("%s: reads a log whose writer died mid-write to its last whole record", async (browser) => {
    const fs = new QueueFs(browser);
    const locks = new TestLocks();
    const w = await startLog(fs, locks, A);
    await append(w, A, 3);
    fs.failNextWrite(A, { mode: "throw", landed: 9 });
    await expect(w.append([body(A, 4)])).rejects.toThrow(/injected write failure/);
    fs.closeHandles(A);
    locks.release(A);

    const [got] = await scan(fs, locks);
    expect(got).toMatchObject({ dead: true, stop: "end" });
    expect(ns(got)).toEqual(range(1, 3));
  });

  it("retries a segment Chrome refuses a few times, and stops the scan there when it keeps refusing", async () => {
    const fs = new QueueFs("chrome");
    const locks = new TestLocks();
    const w = await startLog(fs, locks, A);
    await append(w, A, 3);
    await w.close();
    locks.release(A);
    const refusing = (times: number): AsyncFs => {
      let left = times;
      return Object.assign(Object.create(fs) as QueueFs, {
        read: (path: string, offset: number, length: number) =>
          left-- > 0 ? Promise.reject(new DOMException("busy", "NotReadableError")) : fs.read(path, offset, length),
      });
    };

    const [retried] = await scan(refusing(3), locks);
    expect(retried).toMatchObject({ dead: true, stop: "end" });
    expect(ns(retried)).toEqual(range(1, 3));
    const [refused] = await scan(refusing(Infinity), locks);
    expect(refused).toMatchObject({ dead: true, stop: "partial", records: [] });
  });

  it("lists a dead log again under its lock, and a live one only once", async () => {
    const fs = new QueueFs("safari");
    const locks = new TestLocks();
    const a = await startLog(fs, locks, A, 2);
    const b = await startLog(fs, locks, B, 2);
    await append(a, A, 2);
    await append(b, B, 2);
    const stale = await listLogs(fs);
    await append(a, A, 2);
    await append(b, B, 2);
    await a.flush();
    await b.close();
    locks.release(B);

    const scans = await scanQueues(fs, locks.for("host"), [], stale, async (scans) => scans);
    const byLog = new Map(scans.map((s) => [s.log, s]));
    expect(byLog.get(A)).toMatchObject({ dead: false, stop: "partial" });
    expect(ns(byLog.get(A))).toEqual(range(1, 2));
    expect(byLog.get(B)).toMatchObject({ dead: true, stop: "end" });
    expect(ns(byLog.get(B))).toEqual(range(1, 4));
  });

  it("reads each log from its cursor and skips a final or damaged one", async () => {
    const fs = new QueueFs("firefox");
    const locks = new TestLocks();
    for (const log of [A, B]) {
      const w = await startLog(fs, locks, log, 2);
      await append(w, log, 5);
      await w.close();
      locks.release(log);
    }
    const C = "00000000000000c3" as LogId;
    const c = await startLog(fs, locks, C, 2);
    await append(c, C, 1);
    await c.close();
    locks.release(C);

    const scans = await scan(fs, locks, [
      { log: A, state: "final", n: 5 },
      { log: B, state: "open", n: 3 },
      { log: C, state: "damaged", n: 0, reason: "bad frame" },
    ]);
    expect(scans.map((s) => s.log)).toEqual([B]);
    expect(ns(scans[0])).toEqual([4, 5]);
    expect(locks.heldBy(A)).toBeUndefined();
  });
});

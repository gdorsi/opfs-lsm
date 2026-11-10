import { describe, expect, it } from "vitest";
import type { CheckedKey, CheckedValue } from "../src/check.js";
import { CorruptDatabaseError } from "../src/errors.js";
import { ingestQueues, reclaimQueues, scanQueues, type LogLocks } from "../src/host/queue-host.js";
import { checkCover, type LogFiles, type LogId, type PredEdge, type QueueCursor, type QueueScan } from "../src/host/queues.js";
import { encodeOps } from "../src/idb/wal.js";
import { QueueWriter } from "../src/log/queue-writer.js";
import { segmentPath } from "../src/log/segment.js";
import type { AsyncFs } from "../src/opfs/async-fs.js";
import { MemoryFs } from "../src/opfs/memory-fs.js";
import { recoverQueues } from "../src/recover.js";
import {
  listLogs,
  loadLatestGeneration,
  manifestNumbers,
  publishGeneration,
  publishRun,
  readManifest,
  type GenerationMeta,
} from "../src/store/generation.js";
import { decodeSst } from "../src/store/sst.js";
import { BROWSERS, QueueFs, TestLocks, type Browser } from "./sim/queue-fs.js";

const A = "00000000000000a1" as LogId;
const B = "00000000000000b2" as LogId;
const enc = new TextEncoder();

const body = (log: LogId, n: number): Uint8Array =>
  new Uint8Array(encodeOps([{ type: "put", key: enc.encode(`${log}/${n}`) as CheckedKey, value: enc.encode(`value ${n}`) as CheckedValue }]));
const ns = (scan: QueueScan | undefined): number[] => scan?.records.map((r) => r.n) ?? [];
const range = (lo: number, hi: number): number[] => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
const logIds = (logs: readonly LogFiles[]): LogId[] => logs.map((l) => l.log);

/** A writer of `log` that holds its lock, with room for about `perSegment` records a segment. */
async function startLog(fs: QueueFs, locks: TestLocks, log: LogId, perSegment = 100, pred?: PredEdge): Promise<QueueWriter> {
  locks.hold(log, log);
  return QueueWriter.open(fs.segments, log, { segmentBytes: 32 + perSegment * (13 + body(log, 1).byteLength), ...(pred && { pred }) });
}

async function append(w: QueueWriter, log: LogId, count: number): Promise<void> {
  for (let i = 0; i < count; i++) await w.append([body(log, w.lastAcked + 1)]);
}

async function scan(fs: AsyncFs, locks: TestLocks, queues: QueueCursor[] = []): Promise<readonly QueueScan[]> {
  return scanQueues(fs, locks.for("host"), queues, logIds(await listLogs(fs)), async (scans) => scans);
}

/** The newest manifest, and each record in its runs as `<log>/<n>` with its seq, in seq order. */
async function ingested(fs: AsyncFs): Promise<{ meta: GenerationMeta; seqs: Map<string, number> }> {
  const meta = (await loadLatestGeneration(fs))!;
  const seqs = new Map<string, number>();
  for (const run of meta.runs) {
    for (const e of decodeSst((await fs.read(run.path, 0, Number.POSITIVE_INFINITY))!)) {
      const key = new TextDecoder().decode(e.key);
      expect(seqs.has(key), `${key} is in two runs`).toBe(false);
      seqs.set(key, e.seq!);
    }
  }
  return { meta, seqs: new Map([...seqs].sort((a, b) => a[1] - b[1])) };
}

const keys = (log: LogId, ns: number[]): string[] => ns.map((n) => `${log}/${n}`);

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

    const scans = await scanQueues(fs, locks.for("host"), [], logIds(await listLogs(fs)), async (scans) => {
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
    fs.fail(A, { at: "write", mode: "throw", landed: 9 });
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

  it.each(BROWSERS)("%s: takes the locks before it lists, so a successor made after the candidates were listed caps its dead pred", async (browser) => {
    const fs = new QueueFs(browser);
    const locks = new TestLocks();
    const a = await startLog(fs, locks, A);
    await append(a, A, 2);
    await a.flush();
    let b: QueueWriter | undefined;
    let tab: (() => Promise<void>) | undefined = async () => {
      fs.fail(A, { at: "write", mode: "throw", landed: 1 << 20 });
      await expect(a.append([body(A, 3)])).rejects.toThrow(/injected write failure/);
      b = await startLog(fs, locks, B, 100, { log: A, lastN: 2 });
      fs.closeHandles(A);
      locks.release(A);
    };
    const host = locks.for("host");
    const racing: LogLocks = {
      take: async (log) => {
        const run = tab;
        tab = undefined;
        await run?.();
        return host.take(log);
      },
    };

    const first = await ingestQueues(fs, racing, new Map(), Number.POSITIVE_INFINITY);
    if (browser === "chrome") expect(first.generation, "A waits while B's header is unreadable").toBe(0);
    else expect((await ingested(fs)).meta.queues).toContainEqual({ log: A, state: "final", n: 2 });
    await b!.close();
    locks.release(B);
    await ingestQueues(fs, host, new Map(), Number.POSITIVE_INFINITY);
    const { meta, seqs } = await ingested(fs);
    expect([...seqs.keys()]).toEqual(keys(A, [1, 2]));
    expect(meta.queues).toContainEqual({ log: A, state: "final", n: 2 });
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

describe("ingestQueues", () => {
  const P = "00000000000000a0" as LogId;
  const S = "00000000000000d4" as LogId;

  it("ingests a dead log to its end and a live one up to its flushed record, and publishes nothing when nothing is new", async () => {
    const fs = new QueueFs("safari");
    const locks = new TestLocks();
    const a = await startLog(fs, locks, A, 2);
    await append(a, A, 3);
    await a.close();
    locks.release(A);
    const b = await startLog(fs, locks, B, 2);
    await append(b, B, 4);
    await b.flush();
    const host = locks.for("host");

    expect(await ingestQueues(fs, host, new Map([[B, 2]]), Infinity)).toEqual({ generation: 1, damagedLive: [] });
    const first = await ingested(fs);
    expect(first.meta).toMatchObject({ through: 5, queues: [{ log: A, state: "final", n: 3 }, { log: B, state: "open", n: 2 }] });
    expect([...first.seqs]).toEqual([...keys(A, [1, 2, 3]), ...keys(B, [1, 2])].map((k, i) => [k, i + 1]));
    expect(locks.heldBy(A)).toBeUndefined();

    expect(await ingestQueues(fs, host, new Map([[B, 2]]), Infinity)).toEqual({ generation: 1, damagedLive: [] });
    expect(await ingestQueues(fs, host, new Map([[B, 4]]), Infinity)).toEqual({ generation: 2, damagedLive: [] });
    const second = await ingested(fs);
    expect(second.meta).toMatchObject({ through: 7, queues: [{ log: A, state: "final", n: 3 }, { log: B, state: "open", n: 4 }] });
    expect([second.seqs.get(`${B}/3`), second.seqs.get(`${B}/4`)]).toEqual([6, 7]);
  });

  it("ingests a pred log through the last record its writer acked, and its successor after it", async () => {
    const fs = new QueueFs("safari");
    const locks = new TestLocks();
    const p = await startLog(fs, locks, P);
    await append(p, P, 3);
    await p.flush();
    fs.fail(P, { at: "write", mode: "throw", landed: Infinity });
    await expect(p.append([body(P, 4)])).rejects.toThrow(/injected write failure/);
    const s = await startLog(fs, locks, S, 100, { log: P, lastN: p.lastAcked });
    await append(s, S, 2);
    await s.flush();

    await ingestQueues(fs, locks.for("host"), new Map([[P, 3], [S, 2]]), Infinity);
    const { meta, seqs } = await ingested(fs);
    expect(meta.queues).toEqual([{ log: P, state: "final", n: 3 }, { log: S, state: "open", n: 2 }]);
    expect([...seqs]).toEqual([...keys(P, [1, 2, 3]), ...keys(S, [1, 2])].map((k, i) => [k, i + 1]));
  });

  it("holds a successor until its pred is read through lastN", async () => {
    const fs = new QueueFs("safari");
    const locks = new TestLocks();
    const p = await startLog(fs, locks, P);
    await append(p, P, 3);
    await p.flush();
    const s = await startLog(fs, locks, S, 100, { log: P, lastN: 3 });
    await append(s, S, 1);
    await s.flush();
    const host = locks.for("host");

    await ingestQueues(fs, host, new Map([[P, 2], [S, 1]]), Infinity);
    expect((await ingested(fs)).meta.queues).toEqual([{ log: P, state: "open", n: 2 }]);
    await ingestQueues(fs, host, new Map([[P, 3], [S, 1]]), Infinity);
    const { seqs } = await ingested(fs);
    expect([seqs.get(`${P}/3`), seqs.get(`${S}/1`)]).toEqual([3, 4]);
  });

  it("caps a round at maxBytes, and the rounds take each record once", async () => {
    const fs = new QueueFs("chrome");
    const locks = new TestLocks();
    const a = await startLog(fs, locks, A, 2);
    await append(a, A, 5);
    await a.close();
    locks.release(A);
    const host = locks.for("host");

    for (let round = 1; round <= 5; round++) {
      expect((await ingestQueues(fs, host, new Map(), 1)).generation).toBe(round);
      expect((await ingested(fs)).meta.through).toBe(round);
    }
    const { meta, seqs } = await ingested(fs);
    expect(meta.queues).toEqual([{ log: A, state: "final", n: 5 }]);
    expect([...seqs]).toEqual(keys(A, [1, 2, 3, 4, 5]).map((k, i) => [k, i + 1]));
  });

  it("damages a log at a hole in a middle segment, keeps its files, and ingests the other logs", async () => {
    const fs = new QueueFs("firefox");
    const locks = new TestLocks();
    for (const log of [A, B]) {
      const w = await startLog(fs, locks, log, 2);
      await append(w, log, 6);
      await w.close();
      locks.release(log);
    }
    await fs.remove(segmentPath(A, 3));
    const live = await startLog(fs, locks, P, 2);
    await append(live, P, 6);
    await live.flush();
    await fs.remove(segmentPath(P, 3));

    const out = await ingestQueues(fs, locks.for("host"), new Map([[P, 6]]), Infinity);
    expect(out.damagedLive).toEqual([P]);
    const { meta, seqs } = await ingested(fs);
    expect(meta.queues).toEqual([
      { log: P, state: "damaged", n: 2, reason: "segment ends short" },
      { log: A, state: "damaged", n: 2, reason: "segment ends short" },
      { log: B, state: "final", n: 6 },
    ]);
    expect([...seqs.keys()]).toEqual([...keys(P, [1, 2]), ...keys(A, [1, 2]), ...keys(B, [1, 2, 3, 4, 5, 6])]);
    expect((await listLogs(fs)).find((l) => l.log === A)?.segments).toEqual([1, 5]);
  });
});

describe("reclaimQueues", () => {
  const P = "00000000000000a0" as LogId;
  const S = "00000000000000d4" as LogId;
  const Z = "00000000000000ff" as LogId;

  const segmentsOf = async (fs: AsyncFs, log: LogId): Promise<readonly number[] | undefined> =>
    (await listLogs(fs)).find((l) => l.log === log)?.segments;

  /** Every manifest on disk can still find its records: what recovery needs of whichever one a crash leaves newest. */
  async function expectEveryManifestCovered(fs: AsyncFs): Promise<void> {
    const logs = await listLogs(fs);
    for (const g of await manifestNumbers(fs)) expect(checkCover((await readManifest(fs, g))!.queues ?? [], logs), `manifest ${g}`).toBeUndefined();
  }

  /**
   * A live log whose next record, sealed in its own segment so every
   * browser reads it, makes the next ingest publish a manifest. Its first
   * segment is sealed at once: an unreadable one would hold back dead logs.
   */
  async function churn(fs: QueueFs, locks: TestLocks): Promise<() => Promise<void>> {
    const z = await startLog(fs, locks, Z);
    await append(z, Z, 1);
    await z.rotate();
    return async () => {
      await append(z, Z, 1);
      await z.rotate();
      await ingestQueues(fs, locks.for("host"), new Map([[Z, z.lastAcked]]), Infinity);
    };
  }

  it.each(BROWSERS)("%s: removes the segments the newest three manifests cover, never a live log's last one", async (browser) => {
    const fs = new QueueFs(browser);
    const locks = new TestLocks();
    const a = await startLog(fs, locks, A, 2);
    await append(a, A, 4);
    await a.rotate();
    const next = await churn(fs, locks);
    for (const n of [1, 2, 3, 4]) {
      await ingestQueues(fs, locks.for("host"), new Map([[A, n]]), Infinity);
      await reclaimQueues(fs, locks.for("host"));
      await expectEveryManifestCovered(fs);
    }
    expect(await manifestNumbers(fs)).toEqual([4, 3, 2]);
    expect(await segmentsOf(fs, A)).toEqual([3, 5]);

    await next();
    await next();
    await reclaimQueues(fs, locks.for("host"));
    await expectEveryManifestCovered(fs);
    expect(await segmentsOf(fs, A)).toEqual([5]);
    expect(fs.removedLast).toEqual([]);
  });

  it("removes a dead log's directory only once the newest three manifests have it final", async () => {
    const fs = new QueueFs("chrome");
    const locks = new TestLocks();
    const a = await startLog(fs, locks, A, 2);
    await append(a, A, 3);
    await a.close();
    locks.release(A);
    const next = await churn(fs, locks);
    await ingestQueues(fs, locks.for("host"), new Map(), Infinity);

    for (const round of [1, 2]) {
      await reclaimQueues(fs, locks.for("host"));
      expect(await segmentsOf(fs, A), `after ${round} manifest(s)`).toEqual([1, 3]);
      await next();
    }
    await reclaimQueues(fs, locks.for("host"));
    expect(await segmentsOf(fs, A)).toBeUndefined();
    expect((await loadLatestGeneration(fs))!.queues).toContainEqual({ log: A, state: "final", n: 3 });
    expect(locks.heldBy(A)).toBeUndefined();
  });

  it("keeps the directory of a final log whose writer still holds its lock", async () => {
    const fs = new QueueFs("safari");
    const locks = new TestLocks();
    const p = await startLog(fs, locks, P, 2);
    await append(p, P, 3);
    await p.flush();
    fs.fail(P, { at: "write", mode: "short", landed: 3 });
    await expect(p.append([body(P, 4)])).rejects.toThrow(/short write/);
    const s = await startLog(fs, locks, S, 2, { log: P, lastN: 3 });
    await append(s, S, 1);
    await ingestQueues(fs, locks.for("host"), new Map([[P, 3], [S, await s.flush()]]), Infinity);
    const next = await churn(fs, locks);
    await next();
    await next();

    await reclaimQueues(fs, locks.for("host"));
    expect((await loadLatestGeneration(fs))!.queues).toContainEqual({ log: P, state: "final", n: 3 });
    expect(await segmentsOf(fs, P)).toEqual([3]);
    locks.release(P);
    await reclaimQueues(fs, locks.for("host"));
    expect(await segmentsOf(fs, P)).toBeUndefined();
  });

  it("keeps a damaged log's files from its hole on, and its directory", async () => {
    const fs = new QueueFs("firefox");
    const locks = new TestLocks();
    const a = await startLog(fs, locks, A, 2);
    await append(a, A, 8);
    await a.close();
    locks.release(A);
    await fs.remove(segmentPath(A, 5));
    const next = await churn(fs, locks);
    await ingestQueues(fs, locks.for("host"), new Map(), Infinity);
    await next();
    await next();
    await reclaimQueues(fs, locks.for("host"));

    expect((await loadLatestGeneration(fs))!.queues).toContainEqual({ log: A, state: "damaged", n: 4, reason: "segment ends short" });
    expect(await segmentsOf(fs, A)).toEqual([3, 7]);
  });
});

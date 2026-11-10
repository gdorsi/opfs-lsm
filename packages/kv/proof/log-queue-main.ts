/**
 * Page side of the ingest queue writer proof (`scripts/log-queue.ts`). The
 * harness calls `lq.*` over CDP. Writes go through the real `LogClient`
 * and its dedicated WebWorker; reads list the segment files in OPFS and
 * run the real `scanLog` and `planIngest` on them.
 */
import { checkDbName, checkKey, checkValue, type CheckedOp } from "../src/check.js";
import { planIngest, type LogId, type PredEdge, type QueueScan } from "../src/host/queues.js";
import { LogClient } from "../src/log/client.js";
import { logLockName } from "../src/log/log-worker-boot.js";
import { scanLog, type ListedSegment } from "../src/log/queue-scan.js";
import { parseSegmentName } from "../src/log/segment.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

type Binding = (payload: string) => void;
const ackBinding = (globalThis as unknown as { lqAck?: Binding }).lqAck;

let client: LogClient | undefined;
const durable: [LogId, number][] = [];
const respawned: [LogId, PredEdge][] = [];
const predHeld: Promise<boolean>[] = [];

function ops(label: string, size: number): CheckedOp[] {
  const value = new Uint8Array(Math.max(size, label.length));
  value.set(enc.encode(label));
  return [{ type: "put", key: checkKey(enc.encode(label)), value: checkValue(value) }];
}

function live(): LogClient {
  if (!client) throw new Error("no client: call lq.start first");
  return client;
}

async function logDir(db: string, log?: LogId): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    const root = await navigator.storage.getDirectory();
    const w = await (await (await root.getDirectoryHandle("opfs-lsm")).getDirectoryHandle(db)).getDirectoryHandle("w");
    return log ? await w.getDirectoryHandle(log) : w;
  } catch {
    return undefined;
  }
}

async function names(dir: FileSystemDirectoryHandle): Promise<string[]> {
  const out: string[] = [];
  for await (const [name] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) out.push(name);
  return out;
}

/** Reads `log` as the host would: dead only when its lock is taken before the files are listed. */
async function scan(db: string, log: LogId): Promise<QueueScan & { segments: number }> {
  return await navigator.locks.request(logLockName(checkDbName(db), log), { ifAvailable: true }, async (lock) => {
    const dir = await logDir(db, log);
    const listed: ListedSegment[] = [];
    for (const name of dir ? await names(dir) : []) {
      const firstN = parseSegmentName(name);
      if (firstN === undefined) continue;
      const file = await (await dir!.getFileHandle(name)).getFile();
      listed.push({ firstN, bytes: new Uint8Array(await file.arrayBuffer()) });
    }
    return { ...scanLog(log, 0, lock !== null, listed), segments: listed.length };
  });
}

const summary = (s: QueueScan & { segments: number }) => ({
  log: s.log,
  dead: s.dead,
  pred: s.pred ?? null,
  stop: s.stop,
  segments: s.segments,
  records: s.records.map((r) => ({ n: r.n, label: label(r.ops) })),
});

function label(rops: readonly CheckedOp[]): string {
  return rops[0] ? dec.decode(rops[0].key) : "?";
}

async function heldLocks(): Promise<string[]> {
  const q = await navigator.locks.query();
  return (q.held ?? []).map((l) => l.name ?? "");
}

const lq = {
  ready: true,

  start(db: string, segmentBytes: number): void {
    durable.length = 0;
    respawned.length = 0;
    predHeld.length = 0;
    client = new LogClient({
      db,
      segmentBytes,
      durable: (log, n) => durable.push([log, n]),
      respawned: (log, pred) => {
        respawned.push([log, pred]);
        predHeld.push(lq.lockHeld(db, pred.log));
      },
    });
  },

  /** Appends `count` records `${prefix}-1..` in groups of `group` per task, sizes cycling up to `maxSize`. */
  async appendMany(prefix: string, count: number, group: number, maxSize: number) {
    const acks: { log: LogId; n: number; label: string }[] = [];
    for (let i = 1; i <= count; i += group) {
      const labels = Array.from({ length: Math.min(group, count - i + 1) }, (_, j) => `${prefix}-${i + j}`);
      const got = await Promise.all(labels.map((l, j) => live().append(ops(l, ((i + j) * 37) % maxSize))));
      got.forEach((at, j) => acks.push({ ...at, label: labels[j]! }));
    }
    return acks;
  },

  /** Appends until the page dies, reporting each ack through the `lqAck` binding once it resolves. */
  flood(prefix: string, maxSize: number): void {
    void (async () => {
      for (let i = 1; ; i += 4) {
        await Promise.all(
          [0, 1, 2, 3].map(async (j) => {
            const l = `${prefix}-${i + j}`;
            const at = await live().append(ops(l, ((i + j) * 53) % maxSize));
            ackBinding?.(JSON.stringify({ ...at, label: l }));
          }),
        );
      }
    })();
  },

  /** Appends one record and reports how it settled and after how long. */
  async appendOne(l: string) {
    const t0 = performance.now();
    try {
      const at = await live().append(ops(l, 8));
      return { ok: true, ...at, error: null, ms: Math.round(performance.now() - t0) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.name : String(err), ms: Math.round(performance.now() - t0) };
    }
  },

  flush: () => live().flush(),
  rotate: () => live().rotate(),
  suspend: () => live().suspend(),
  resume: () => live().resume(),
  close: () => live().close(),
  events: () => ({ durable, respawned }),
  /** Per respawn: did the pred log still hold its lock when its successor had opened? */
  predHeldAtRespawn: () => Promise.all(predHeld),

  async lockHeld(db: string, log: LogId): Promise<boolean> {
    return (await heldLocks()).includes(logLockName(checkDbName(db), log));
  },

  /** Milliseconds until `log`'s lock is free, or -1 after `timeoutMs`. */
  async lockFreeAfter(db: string, log: LogId, timeoutMs: number): Promise<number> {
    const t0 = performance.now();
    while (performance.now() - t0 < timeoutMs) {
      if (!(await lq.lockHeld(db, log))) return Math.round(performance.now() - t0);
      await new Promise((r) => setTimeout(r, 25));
    }
    return -1;
  },

  async read(db: string, log: LogId) {
    return summary(await scan(db, log));
  },

  async logs(db: string): Promise<string[]> {
    const w = await logDir(db);
    return w ? names(w) : [];
  },

  /** What the host would ingest from every log of `db`, in ingest order. */
  async applied(db: string) {
    const scans = await Promise.all((await lq.logs(db)).map((l) => scan(db, l as LogId)));
    const plan = planIngest({ through: 0, queues: [] }, scans, new Map(), Infinity);
    return { live: scans.filter((s) => !s.dead).map((s) => s.log), labels: plan.records.map((r) => label(r.ops)) };
  },
};

(globalThis as unknown as { lq: typeof lq }).lq = lq;
document.getElementById("status")!.textContent = "ready";

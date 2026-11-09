import type { CheckedOp } from "../check.js";

/**
 * One dedicated WebWorker's log: fresh per spawn, never reused. A tab gets a
 * new one on reload and after any failed write.
 */
export type LogId = string & { readonly __brand: "LogId" };

/** Record number inside one log: 1, 2, 3 ... with no gaps. */
export type RecordN = number;

/**
 * In a log's first segment header after a failed write: the writer gave up
 * `log` with `lastN` its last acked record. `log` is ingested through
 * `lastN` before this log, and nothing of it past `lastN`.
 */
export type PredEdge = { readonly log: LogId; readonly lastN: RecordN };

/**
 * One log's ingest cursor, carried in the manifest: records 1..n are in the
 * runs. `final` and `damaged` are terminal; only `planIngest` moves a cursor.
 * An absent cursor is `open` at 0.
 */
export type QueueCursor =
  | { readonly log: LogId; readonly state: "open"; readonly n: RecordN }
  /** No record past `n` will ever be ingested: the log is dead and read to its end, or a successor capped it at `n`. */
  | { readonly log: LogId; readonly state: "final"; readonly n: RecordN }
  /** Records past `n` are unreadable (a hole). The files are kept. */
  | { readonly log: LogId; readonly state: "damaged"; readonly n: RecordN; readonly reason: string };

/** What `planIngest` needs of the manifest it builds on. */
export type QueueBase = {
  /** The runs hold seqs 1..through. */
  readonly through: number;
  readonly queues: readonly QueueCursor[];
};

/** One read of a log from its base cursor, with `getFile()` only. */
export type QueueScan = {
  readonly log: LogId;
  /** The host holds the log's Web Lock: its writer is gone and never writes again. */
  readonly dead: boolean;
  /** From the first segment's header; absent once that segment is reclaimed. */
  readonly pred?: PredEdge;
  /** Whole valid records after the cursor, in n order with no gaps. */
  readonly records: readonly { readonly n: RecordN; readonly ops: readonly CheckedOp[]; readonly bytes: number }[];
  /**
   * How the read ended. "end": no more valid frames. "busy": the active
   * segment could not be read this round. A hole: record `hole` is
   * unreadable but something after it is there.
   */
  readonly stop: "end" | "busy" | { readonly hole: RecordN; readonly reason: string };
};

/** Flushed n per live log, from the tabs' `durable` messages. Missing = nothing flushed. */
export type DurableHints = ReadonlyMap<LogId, RecordN>;

export type IngestPlan = {
  /** The L0's records, seqs base.through+1 .. through in order. */
  readonly records: readonly { readonly seq: number; readonly log: LogId; readonly n: RecordN; readonly ops: readonly CheckedOp[] }[];
  readonly through: number;
  /** The next manifest's cursors, sorted by log. */
  readonly queues: readonly QueueCursor[];
  /** Live logs that hit a hole: their tabs re-append what they still hold. */
  readonly damagedLive: readonly LogId[];
};

const terminal = (c: QueueCursor | undefined): boolean => c !== undefined && c.state !== "open";
const byLogId = (a: { log: LogId }, b: { log: LogId }): number => (a.log < b.log ? -1 : a.log > b.log ? 1 : 0);

/**
 * The next manifest's L0 and cursors. Ingest order is the only order, so
 * every rule about it lives here: a live log gives records up to its
 * durable hint, a dead one up to its end; a log with a pred waits until
 * the pred's cursor is terminal, and caps the pred at `lastN`; a hole
 * damages the log. `maxBytes` caps the L0, though one record always goes.
 */
export function planIngest(base: QueueBase, scans: readonly QueueScan[], durable: DurableHints, maxBytes: number): IngestPlan {
  const next = new Map(base.queues.map((c) => [c.log, c]));
  const byLog = new Map(scans.map((s) => [s.log, s]));
  const cap = new Map<LogId, RecordN>();
  for (const s of scans) if (s.pred) cap.set(s.pred.log, Math.min(cap.get(s.pred.log) ?? Infinity, s.pred.lastN));

  const records: IngestPlan["records"][number][] = [];
  const damagedLive: LogId[] = [];
  let through = base.through;
  let bytes = 0;
  let full = false;
  const seen = new Set<LogId>();

  const visit = (scan: QueueScan): void => {
    const { log } = scan;
    if (seen.has(log)) return;
    seen.add(log);
    const pred = scan.pred && byLog.get(scan.pred.log);
    if (pred) visit(pred);
    if (scan.pred && !terminal(next.get(scan.pred.log))) return;

    const cur = next.get(log) ?? { log, state: "open", n: 0 };
    if (cur.state !== "open") return;
    const capN = cap.get(log);
    const limit = Math.min(scan.dead ? Infinity : (durable.get(log) ?? 0), capN ?? Infinity);
    let n = cur.n;
    let tookAll = true;
    for (const r of scan.records) {
      if (r.n <= n) continue;
      if (r.n !== n + 1 || r.n > limit) {
        tookAll = false;
        break;
      }
      if (full || (bytes > 0 && bytes + r.bytes > maxBytes)) {
        full = true;
        tookAll = false;
        break;
      }
      records.push({ seq: ++through, log, n: r.n, ops: r.ops });
      bytes += r.bytes;
      n = r.n;
    }

    if (capN !== undefined && n >= capN) next.set(log, { log, state: "final", n });
    else if (typeof scan.stop === "object" && tookAll && n === scan.stop.hole - 1) {
      next.set(log, { log, state: "damaged", n, reason: scan.stop.reason });
      if (!scan.dead) damagedLive.push(log);
    } else if (scan.dead && scan.stop === "end" && tookAll) next.set(log, { log, state: "final", n });
    else next.set(log, { log, state: "open", n });
  };
  for (const s of [...scans].sort(byLogId)) visit(s);

  const queues = [...next.values()].filter((c) => c.state !== "open" || c.n > 0).sort(byLogId);
  return { records, through, queues, damagedLive };
}

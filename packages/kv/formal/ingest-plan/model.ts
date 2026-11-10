/**
 * Model of per-tab logs as ingest queues (design/ingest-queue). Each tab's
 * dedicated WebWorker appends to its own log; the SharedWorker lists the
 * logs and their segment files, and later reads those files, plans with the
 * real `planIngest`, commits a manifest and reclaims with the real
 * `planReclaim`. Between the listing and the plan, writers go on, so the
 * listing can miss a new log or segment. A rotation is two writer steps,
 * creating the successor and sealing the old segment, so a tab can die
 * between them, and so can the browser. A history ends in a browser crash,
 * which kills every writer, may cut each log's unflushed tail, damage a
 * frame or drop a segment file, and drops up to `Bounds.drops` newest
 * manifests; recovery opens with the real `checkCover` and drains with
 * `planIngest`.
 *
 * A write is an id. A record's ops carry its id, so a manifest's stream is
 * the write ids it ingested, in seq order. State is plain JSON with every
 * per-log map keyed by all of LOGS in order, so JSON.stringify is canonical.
 */
import type { CheckedKey, CheckedOp, CheckedValue } from "../../src/check.js";
import {
  checkCover,
  planIngest,
  planReclaim,
  RECLAIM_LAG,
  type IngestPlan,
  type LogFiles,
  type LogId,
  type PredEdge,
  type QueueCursor,
  type QueueScan,
} from "../../src/host/queues.js";

/** Tab 0 writes `p`, and after a failed write `a`, which sorts first. Tab 1 writes `q`. */
const TAB_LOGS = [["p", "a"], ["q"]] as LogId[][];
const LOGS = ["a", "p", "q"] as LogId[];
/** Only tab 0 ever fails a write. */
const FAILING_TAB = 0;

/** `drops`: the most manifests a crash drops. */
export type Bounds = { readonly appends: number; readonly commits: number; readonly segCap: number; readonly drops: number };

/** Broken rules, one at a time, to show the model catches each. */
export type Variant = {
  /** (a) After a failed write the writer opens segment lastAcked+1 in the same log (the deleted path). */
  readonly sameLogRecovery?: boolean;
  /** (b) The planner never sees pred edges. */
  readonly ignorePred?: boolean;
  /** (c) A live log's durable hint is whatever the scan found. */
  readonly ignoreHints?: boolean;
  /** Reclaim lag in generations; (d) is 0. Defaults to RECLAIM_LAG. */
  readonly lag?: number;
  /** (e) Rotation seals the old segment before it creates the successor. */
  readonly sealFirst?: boolean;
};

type Frame = { n: number; w: number; ok: boolean };
/** `sealed`: closed by a SEAL frame, written and flushed once its successor exists. */
type Segment = { firstN: number; frames: Frame[]; sealed: boolean };
type Writer = {
  tab: number;
  pred: PredEdge | null;
  /** live: the tab's current log. abandoned: given up after a failed write, its lock still held. */
  state: "live" | "abandoned" | "dead";
  acked: number;
  flushed: number;
  /** While a rotation is half done: the firstN of the segment it rotates off. */
  rotating: number | null;
};
/** `l6`: ingested from a dead log past its flushed n (design L6). */
type Write = { id: number; log: LogId; n: number; acked: boolean; deps: number[]; l6: boolean };
export type Manifest = { gen: number; through: number; queues: QueueCursor[]; stream: number[] };
type Snap = { dead: boolean; pred: PredEdge | null; records: [number, number][]; stop: QueueScan["stop"] };

export type State = {
  logs: Record<string, { segments: Segment[] } | null>;
  writers: Record<string, Writer | null>;
  tabs: { log: LogId; next: number; phase: "ok" | "failed" | "dead" }[];
  writes: Write[];
  manifests: Manifest[];
  /** An ingest in progress: its base and the segment files it listed per log. */
  pass: { base: number; listed: Record<string, number[] | null> } | null;
  hints: Record<string, number>;
  /** First record of the log lost to a dropped segment file or a damaged frame. */
  faultLoss: Record<string, number | null>;
  /** First record of the log lost to the crash cutting its unflushed tail. */
  cutLoss: Record<string, number | null>;
  used: { appends: number; fails: number; commits: number };
  crash: { drops: number; fault: boolean; refused: string | null } | null;
};

export type Action = { readonly label: string; readonly apply: (s: State) => void };
type RotationStep = { readonly verb: "create" | "seal"; readonly file: string; readonly apply: (s: State) => void };

const ZERO: Manifest = { gen: 0, through: 0, queues: [], stream: [] };
const per = <T>(v: T): Record<string, T> => Object.fromEntries(LOGS.map((l) => [l, v]));

/** A copy of a state that keeps key order, so it stringifies the same; about three times faster than parsing its JSON again. */
export function clone<T>(v: T): T {
  if (typeof v !== "object" || v === null) return v;
  if (Array.isArray(v)) return v.map(clone) as T;
  const out: Record<string, unknown> = {};
  for (const k in v) out[k] = clone(v[k]);
  return out as T;
}

const opsCache: CheckedOp[][] = [];
function opsOf(w: number): CheckedOp[] {
  return (opsCache[w] ??= [{ type: "put", key: Uint8Array.of(w) as CheckedKey, value: Uint8Array.of(w) as CheckedValue }]);
}
const idOf = (ops: readonly CheckedOp[]): number => ops[0]!.key[0]!;

function spawn(s: State, tab: number, log: LogId, pred: PredEdge | null): void {
  s.logs[log] = { segments: [{ firstN: 1, frames: [], sealed: false }] };
  s.writers[log] = { tab, pred, state: "live", acked: 0, flushed: 0, rotating: null };
}

export function initial(): State {
  const s: State = {
    logs: per(null),
    writers: per(null),
    tabs: [],
    writes: [],
    manifests: [],
    pass: null,
    hints: per(0),
    faultLoss: per(null),
    cutLoss: per(null),
    used: { appends: 0, fails: 0, commits: 0 },
    crash: null,
  };
  TAB_LOGS.forEach((ids, tab) => {
    spawn(s, tab, ids[0]!, null);
    s.tabs.push({ log: ids[0]!, next: 1, phase: "ok" });
  });
  return s;
}

const newest = (s: State): Manifest => s.manifests[s.manifests.length - 1] ?? ZERO;
const cursorOf = (m: Manifest, log: LogId): QueueCursor | undefined => m.queues.find((c) => c.log === log);
const lossOf = (s: State, log: LogId): number => Math.min(s.faultLoss[log] ?? Infinity, s.cutLoss[log] ?? Infinity);
const lower = (cur: number | null, n: number): number => Math.min(cur ?? Infinity, n);
const lastFrame = (s: State, log: LogId): number => Math.max(0, ...(s.logs[log]?.segments ?? []).flatMap((g) => g.frames.map((f) => f.n)));
const seen = (s: State): number[] => [...newest(s).stream].sort((x, y) => x - y);

function logFiles(s: State): LogFiles[] {
  return LOGS.flatMap((log) => {
    const l = s.logs[log];
    return l ? [{ log, segments: l.segments.map((g) => g.firstN) }] : [];
  });
}

/**
 * The SharedWorker's reader on one log from cursor `from`, over the segment
 * files it listed (default: all of them) as they are now: segment by
 * segment, each ending at its successor's firstN - 1 (bytes past that are
 * never read). A bad frame is a hole when a later segment follows it. In
 * the last segment it is the end for now while the log is live, since its
 * writer may still be writing there, and once dead a hole only when a
 * whole frame or a SEAL follows it. A sealed last segment means a successor
 * exists: of a live log, one listed too late; of a dead log, whose listing
 * the host takes while holding its lock, one that is gone.
 */
export function read(s: State, log: LogId, from: number, listed?: readonly number[]): Snap {
  const segs = s.logs[log]!.segments.filter((g) => !listed || listed.includes(g.firstN));
  const w = s.writers[log]!;
  const pred = segs[0]?.firstN === 1 ? w.pred : null;
  const records: [number, number][] = [];
  const out = (stop: Snap["stop"]): Snap => ({ dead: w.state === "dead", pred, records, stop });
  let expect = from + 1;
  let i = -1;
  for (let k = 0; k < segs.length; k++) if (segs[k]!.firstN <= expect) i = k;
  if (i < 0) return out(segs.length === 0 ? "end" : { hole: expect, reason: "segment missing" });
  for (; i < segs.length; i++) {
    const seg = segs[i]!;
    const next = segs[i + 1];
    if (seg.firstN > expect) return out({ hole: expect, reason: "segment missing" });
    const end = next ? next.firstN - 1 : Infinity;
    const frames = seg.frames.filter((f) => f.n >= expect && f.n <= end);
    for (let j = 0; j < frames.length; j++) {
      const f = frames[j]!;
      if (!f.ok) {
        const signedAfter = seg.sealed || frames.slice(j + 1).some((g) => g.ok);
        return out(next || (w.state === "dead" && signedAfter) ? { hole: expect, reason: "bad frame" } : "end");
      }
      records.push([f.n, f.w]);
      expect++;
    }
    if (!next) return out(!seg.sealed ? "end" : w.state === "dead" ? { hole: expect, reason: "sealed segment has no successor" } : "partial");
    if (expect <= end) return out({ hole: expect, reason: "segment ends short" });
  }
  return out("end");
}

function toScan(log: LogId, snap: Snap, v: Variant): QueueScan {
  const records = snap.records.map(([n, w]) => ({ n, ops: opsOf(w), bytes: 1 }));
  const scan: QueueScan = { log, dead: snap.dead, records, stop: snap.stop };
  return snap.pred && !v.ignorePred ? { ...scan, pred: snap.pred } : scan;
}

export class PlanError extends Error {}

/**
 * The real planner on `scans`, checked for what the model can see of the
 * plan itself: seqs numbered on from the base's through with no gap, and
 * each record labelled with the log and n of the write it carries.
 */
function plan(base: Manifest, scans: QueueScan[], hints: Map<LogId, number>, maxBytes: number, s: State): { plan: IngestPlan; ids: number[] } {
  const p = planIngest(base, scans, hints, maxBytes);
  const ids = p.records.map((r) => idOf(r.ops));
  p.records.forEach((r, i) => {
    const w = s.writes[ids[i]! - 1]!;
    if (r.seq !== base.through + 1 + i) throw new PlanError(`record ${r.log}${r.n} got seq ${r.seq}, not ${base.through + 1 + i} (base through ${base.through})`);
    if (w.log !== r.log || w.n !== r.n) throw new PlanError(`record ${r.log}${r.n} carries write ${w.id}, which is ${w.log}${w.n}`);
  });
  if (p.through !== base.through + p.records.length) throw new PlanError(`plan through ${p.through} after ${p.records.length} records on ${base.through}`);
  return { plan: p, ids };
}

const sameQueues = (a: readonly QueueCursor[], b: readonly QueueCursor[]): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Every action enabled in `s` but a crash. Each `apply` mutates a fresh copy of `s`. */
export function actions(s: State, v: Variant, b: Bounds): Action[] {
  const out: Action[] = [];
  const add = (label: string, apply: (s: State) => void) => out.push({ label, apply });

  s.tabs.forEach((t, tab) => {
    if (t.phase === "dead") return;
    add(`tab ${tab} dies`, (s) => {
      s.tabs[tab]!.phase = "dead";
      for (const log of LOGS) {
        const w = s.writers[log];
        if (w?.tab === tab) w.state = "dead";
      }
    });
    const log = t.log;
    if (t.phase === "failed") {
      add(v.sameLogRecovery ? `tab ${tab} reopens ${log} at a new segment` : `tab ${tab} starts ${TAB_LOGS[tab]![t.next]} with pred ${log}`, (s) => {
        const tt = s.tabs[tab]!;
        const w = s.writers[log]!;
        tt.phase = "ok";
        if (v.sameLogRecovery) {
          const segs = s.logs[log]!.segments;
          w.flushed = w.acked;
          w.rotating = null;
          if (segs[segs.length - 1]!.firstN === w.acked + 1) segs[segs.length - 1]!.frames = [];
          else segs.push({ firstN: w.acked + 1, frames: [], sealed: false });
          return;
        }
        const succ = TAB_LOGS[tab]![tt.next++]!;
        spawn(s, tab, succ, { log, lastN: w.acked });
        w.state = "abandoned";
        tt.log = succ;
      });
      return;
    }
    const w = s.writers[log]!;
    const segs = s.logs[log]!.segments;
    const last = segs[segs.length - 1]!;
    const next = w.acked + 1;
    const old = w.rotating ?? last.firstN;
    const create: RotationStep = { verb: "create", file: `${log}/${next}.seg`, apply: (s) => void s.logs[log]!.segments.push({ firstN: next, frames: [], sealed: false }) };
    const seal: RotationStep = {
      verb: "seal",
      file: `${log}/${old}.seg`,
      apply: (s) => {
        // Reclaim may have removed it already: the SEAL then lands in no listed file.
        const g = s.logs[log]!.segments.find((x) => x.firstN === old);
        if (g) g.sealed = true;
      },
    };
    const [first, second] = v.sealFirst ? [seal, create] : [create, seal];
    if (w.rotating !== null) {
      add(`${log} ${second.verb}s ${second.file}`, (s) => {
        second.apply(s);
        s.writers[log]!.rotating = null;
      });
    } else if (last.frames.length >= b.segCap && s.used.appends < b.appends) {
      // Only while an append is left, as a size-triggered rotation: rotating after the last append passes too, at twice the states.
      add(`${log} ${first.verb}s ${first.file}`, (s) => {
        const w = s.writers[log]!;
        w.flushed = w.acked;
        w.rotating = old;
        first.apply(s);
      });
    } else if (s.used.appends < b.appends) {
      add(`${log} appends ${log}${next}`, (s) => {
        const w = s.writers[log]!;
        const segs = s.logs[log]!.segments;
        const id = s.writes.length + 1;
        segs[segs.length - 1]!.frames.push({ n: next, w: id, ok: true });
        s.writes.push({ id, log, n: next, acked: true, deps: seen(s), l6: false });
        w.acked = next;
        s.used.appends++;
      });
    }
    if (w.flushed < w.acked) {
      add(`${log} flushes through ${w.acked}`, (s) => {
        const w = s.writers[log]!;
        w.flushed = w.acked;
        s.hints[log] = w.acked;
      });
    }
    if (tab === FAILING_TAB && s.used.fails < 1 && w.rotating !== null) {
      add(`${log} fails to ${second.verb} ${second.file}`, (s) => {
        s.tabs[tab]!.phase = "failed";
        s.used.fails++;
      });
    } else if (tab === FAILING_TAB && s.used.fails < 1) {
      for (const outcome of ["lost", "landed"] as const) {
        add(`${log} fails writing ${log}${w.acked + 1} (frame ${outcome})`, (s) => {
          const w = s.writers[log]!;
          const segs = s.logs[log]!.segments;
          const seg = segs[segs.length - 1]!;
          const id = s.writes.length + 1;
          const n = w.acked + 1;
          s.writes.push({ id, log, n, acked: false, deps: seen(s), l6: false });
          if (outcome === "landed") seg.frames.push({ n, w: id, ok: true });
          s.tabs[tab]!.phase = "failed";
          s.used.fails++;
        });
      }
    }
  });

  for (const log of LOGS) {
    if (s.writers[log]?.state === "abandoned") add(`${log}'s old writer ends (lock released)`, (s) => void (s.writers[log]!.state = "dead"));
  }

  if (s.pass === null) {
    if (s.used.commits < b.commits) {
      add("host lists the logs", (s) => {
        s.pass = { base: newest(s).gen, listed: Object.fromEntries(LOGS.map((l) => [l, s.logs[l]?.segments.map((g) => g.firstN) ?? null])) };
      });
    }
    const r = planReclaim(
      s.manifests.map((m) => ({ generation: m.gen, queues: m.queues })),
      logFiles(s),
      new Set(LOGS.filter((l) => s.writers[l]?.state === "dead")),
      v.lag ?? RECLAIM_LAG,
    );
    if (r.manifests.length + r.segments.length + r.logs.length > 0) {
      const what = [...r.manifests.map((g) => `m/${g}`), ...r.segments.map((g) => `${g.log}/${g.firstN}.seg`), ...r.logs.map((l) => `${l}/`)];
      add(`host reclaims ${what.join(" ")}`, (s) => {
        s.manifests = s.manifests.filter((m) => !r.manifests.includes(m.gen));
        for (const g of r.segments) s.logs[g.log]!.segments = s.logs[g.log]!.segments.filter((x) => x.firstN !== g.firstN);
        for (const l of r.logs) s.logs[l] = null;
      });
    }
  } else {
    const pass = s.pass;
    const base = s.manifests.find((m) => m.gen === pass.base) ?? ZERO;
    for (const maxBytes of [Infinity, 1]) {
      add(`host reads what it listed, plans${maxBytes === 1 ? " one record" : ""} and commits`, (s) => {
        const snaps = new Map(
          LOGS.flatMap((l) => {
            const listed = pass.listed[l];
            if (!listed) return [];
            const live = s.writers[l]!.state !== "dead";
            return [[l, read(s, l, cursorOf(base, l)?.n ?? 0, live ? listed : undefined)] as const];
          }),
        );
        const scans = [...snaps].map(([l, snap]) => toScan(l, snap, v));
        const hints = new Map<LogId, number>();
        for (const sc of scans) {
          if (!sc.dead) hints.set(sc.log, v.ignoreHints ? Math.max(0, ...sc.records.map((r) => r.n)) : s.hints[sc.log]!);
        }
        const { plan: p, ids } = plan(base, scans, hints, maxBytes, s);
        s.pass = null;
        if (ids.length === 0 && sameQueues(p.queues, base.queues)) return;
        for (const id of ids) {
          const w = s.writes[id - 1]!;
          if (w.n > s.writers[w.log]!.flushed && snaps.get(w.log)!.dead) w.l6 = true;
        }
        s.manifests.push({ gen: newest(s).gen + 1, through: p.through, queues: [...p.queues], stream: [...base.stream, ...ids] });
        s.used.commits++;
      });
    }
  }

  return out;
}

/**
 * What a crash or a drain from `s` depends on: the files, the writes, and
 * each writer's pred, flushed n and whether it is gone. States equal on it
 * crash and drain the same way.
 */
export function diskKey(s: State): string {
  const writers = LOGS.map((l) => {
    const w = s.writers[l];
    return w && [w.pred, w.flushed, w.state === "dead"];
  });
  return JSON.stringify([s.logs, writers, s.manifests, s.writes]);
}

/**
 * Every browser crash from `s`, a state with no pass open: each log's tail
 * cut anywhere between its flushed n and its last frame; at most one fault,
 * a damaged frame with a valid one after it (a hole) or a dropped segment
 * file; and the newest 0 to `b.drops` manifests dropped. Recovery then picks the
 * newest manifest left and runs the cover check. A crash ends the history.
 */
export function crashes(s: State, b: Bounds): Action[] {
  let cuts: [LogId, number][][] = [[]];
  for (const log of LOGS) {
    if (!s.logs[log]) continue;
    const last = lastFrame(s, log);
    const options: [LogId, number][] = [];
    for (let c = Math.min(s.writers[log]!.flushed, last); c < last; c++) options.push([log, c]);
    cuts = cuts.flatMap((prefix) => [prefix, ...options.map((o) => [...prefix, o])]);
  }
  const out: Action[] = [];
  for (const cut of cuts) {
    const cutAt = new Map(cut);
    const keeps = (log: LogId, n: number) => n <= (cutAt.get(log) ?? Infinity);
    const faults: (null | { label: string; log: LogId; at: number; apply: (s: State) => void })[] = [null];
    for (const log of LOGS) {
      const l = s.logs[log];
      if (!l) continue;
      for (const g of l.segments) {
        faults.push({ label: `drops ${log}/${g.firstN}.seg`, log, at: g.firstN, apply: (s) => void (s.logs[log]!.segments = s.logs[log]!.segments.filter((x) => x.firstN !== g.firstN)) });
      }
      const frames = l.segments.flatMap((g) => g.frames).filter((f) => keeps(log, f.n));
      for (const f of frames) {
        if (!f.ok || !frames.some((x) => x.ok && x.n > f.n)) continue;
        faults.push({
          label: `damages frame ${log}${f.n}`,
          log,
          at: f.n,
          apply: (s) => {
            for (const g of s.logs[log]!.segments) for (const x of g.frames) if (x.n === f.n && x.w === f.w) x.ok = false;
          },
        });
      }
    }
    for (const fault of faults) {
      for (let drops = 0; drops <= Math.min(b.drops, s.manifests.length); drops++) {
        const label = [
          "browser crash",
          cut.length ? `cuts ${cut.map(([l, c]) => `${l} after ${c}`).join(", ")}` : "",
          fault?.label ?? "",
          drops ? `drops the newest ${drops} manifest${drops > 1 ? "s" : ""}` : "",
        ].filter(Boolean).join(", ");
        out.push({
          label,
          apply: (s) => {
            for (const [log, c] of cut) {
              for (const g of s.logs[log]!.segments) g.frames = g.frames.filter((f) => f.n <= c);
              s.cutLoss[log] = lower(s.cutLoss[log] ?? null, c + 1);
            }
            if (fault) {
              fault.apply(s);
              s.faultLoss[fault.log] = lower(s.faultLoss[fault.log] ?? null, fault.at);
            }
            for (const log of LOGS) {
              const w = s.writers[log];
              if (w) Object.assign(w, { state: "dead", acked: 0, flushed: 0, rotating: null });
            }
            s.tabs = s.tabs.map(() => ({ log: "" as LogId, next: 0, phase: "dead" }));
            s.manifests = s.manifests.slice(0, s.manifests.length - drops);
            s.pass = null;
            s.hints = per(0);
            s.used = { appends: 0, fails: 0, commits: 0 };
            s.crash = { drops, fault: fault !== null, refused: checkCover(newest(s).queues, logFiles(s)) ?? null };
          },
        });
      }
    }
  }
  return out;
}

/**
 * The stream properties of manifest `m`: no write and no (log, n) twice;
 * each log's records in n order; a successor's records after all of its
 * pred's; and no acked record skipped: every acked record at or below an
 * open or damaged cursor, or of a final log, is in the stream unless it is
 * at or past the first record the log lost to a fault or the crash.
 */
function streamProblem(s: State, m: Manifest): string | undefined {
  const pos = new Map<number, number>();
  const at = new Set<string>();
  const last = new Map<LogId, number>();
  for (const [i, id] of m.stream.entries()) {
    const w = s.writes[id - 1]!;
    if (pos.has(id)) return `write ${id} (${w.log}${w.n}) ingested twice`;
    if (at.has(`${w.log}${w.n}`)) return `${w.log}${w.n} ingested twice, as writes ${m.stream.filter((x) => s.writes[x - 1]!.log === w.log && s.writes[x - 1]!.n === w.n).join(" and ")}`;
    if ((last.get(w.log) ?? 0) >= w.n) return `${w.log}${w.n} ingested after ${w.log}${last.get(w.log)}`;
    pos.set(id, i);
    at.add(`${w.log}${w.n}`);
    last.set(w.log, w.n);
  }
  for (const log of LOGS) {
    const pred = s.writers[log]?.pred;
    if (!pred) continue;
    const predAt = m.stream.flatMap((id, i) => (s.writes[id - 1]!.log === pred.log ? [i] : []));
    const succAt = m.stream.flatMap((id, i) => (s.writes[id - 1]!.log === log ? [i] : []));
    if (predAt.length && succAt.length && Math.max(...predAt) > Math.min(...succAt)) {
      const late = s.writes[m.stream[Math.max(...predAt)]! - 1]!;
      const early = s.writes[m.stream[Math.min(...succAt)]! - 1]!;
      return `${late.log}${late.n} ingested after ${early.log}${early.n}, the first record of its successor`;
    }
  }
  for (const c of m.queues) {
    for (const w of s.writes) {
      if (w.log !== c.log || !w.acked || w.n >= lossOf(s, w.log)) continue;
      if ((c.state === "final" || w.n <= c.n) && !pos.has(w.id)) return `acked ${w.log}${w.n} (write ${w.id}) skipped: cursor ${c.log} ${c.state} at ${c.n}`;
    }
  }
  return undefined;
}

/**
 * Safety in every state, of the manifest recovery would pick: the stream
 * properties; a healthy database opens; a crash that dropped at most one
 * manifest and no file recovers.
 */
export function problem(s: State): string | undefined {
  if (s.crash?.refused) {
    return s.crash.drops < 2 && !s.crash.fault ? `recovery refused after ${s.crash.drops} dropped manifest(s): ${s.crash.refused}` : undefined;
  }
  const m = newest(s);
  const p = streamProblem(s, m);
  if (p) return `manifest ${m.gen}: ${p}`;
  if (!s.crash) {
    const cover = checkCover(m.queues, logFiles(s));
    if (cover) return `a healthy database would refuse to open: ${cover}`;
  }
  return undefined;
}

export const allDead = (s: State): boolean => !s.crash?.refused && LOGS.every((l) => !s.writers[l] || s.writers[l]!.state === "dead");

/** With every writer gone: the host plans from fresh scans of every log until nothing changes. */
export function drain(s: State, v: Variant): Manifest {
  let m = newest(s);
  for (let round = 0; round < 10; round++) {
    const scans = LOGS.flatMap((l) => (s.logs[l] ? [toScan(l, read(s, l, cursorOf(m, l)?.n ?? 0), v)] : []));
    const { plan: p, ids } = plan(m, scans, new Map(), Infinity, s);
    if (ids.length === 0 && sameQueues(p.queues, m.queues)) break;
    m = { gen: m.gen + 1, through: p.through, queues: [...p.queues], stream: [...m.stream, ...ids] };
  }
  return m;
}

/**
 * After a drain: the stream properties; every log on disk final or damaged,
 * damaged only where a fault is; every acked record not lost to a fault or
 * the crash ingested, so recovery never opened with a silent hole; and every
 * write a tab had seen ingested when it wrote still ingested, unless a fault
 * took it or it came from a dead log's unflushed tail (design L6).
 */
export function drainProblem(s: State, m: Manifest): string | undefined {
  const sp = streamProblem(s, m);
  if (sp) return `after the drain: ${sp}`;
  for (const log of LOGS) {
    if (!s.logs[log]) continue;
    const c = cursorOf(m, log);
    if (!c || c.state === "open") return `after the drain: ${log} is still ${c ? `open at ${c.n}` : "not ingested"}`;
    if (c.state === "damaged" && s.faultLoss[log] === null) return `after the drain: ${log} damaged at ${c.n} with no fault in it`;
  }
  const ingested = new Set(m.stream);
  for (const w of s.writes) {
    if (w.acked && w.n < lossOf(s, w.log) && !ingested.has(w.id)) return `after the drain: acked ${w.log}${w.n} (write ${w.id}) is not in the stream`;
  }
  for (const y of m.stream) {
    for (const x of s.writes[y - 1]!.deps) {
      const wx = s.writes[x - 1]!;
      if (ingested.has(x) || wx.n >= (s.faultLoss[wx.log] ?? Infinity) || wx.l6) continue;
      const wy = s.writes[y - 1]!;
      return `after the drain: ${wy.log}${wy.n} is ingested but ${wx.log}${wx.n}, which its tab had seen ingested, is gone`;
    }
  }
  return undefined;
}

/** A write ingested before one its tab had seen ingested when it wrote: the first such pair in `m`. */
export function causalReorder(s: State, m: Manifest): string | undefined {
  const pos = new Map(m.stream.map((id, i) => [id, i]));
  for (const y of m.stream) {
    for (const x of s.writes[y - 1]!.deps) {
      const at = pos.get(x);
      if (at !== undefined && at > pos.get(y)!) {
        const wx = s.writes[x - 1]!;
        const wy = s.writes[y - 1]!;
        return `${wy.log}${wy.n} is ingested before ${wx.log}${wx.n}, which its tab had seen ingested when it wrote it`;
      }
    }
  }
  return undefined;
}

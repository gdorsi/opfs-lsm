import type { IngestStep } from "./parse-ingest-order.js";

/** One key — enough to state visibility; values are write sequence numbers. */
export const KEY = "k";

export type WalRec = { seq: number; value: number };

export type ModelState = {
  /** Ack'd WAL rows (deleted from visibility once ingestedThrough passes them). */
  wal: readonly WalRec[];
  ingestedThrough: number;
  nextSeq: number;
  /** Visible SST contents for KEY after publishGeneration. */
  sst: number | undefined;
  /** L0 bytes on disk but not yet pointed at by a generation (after publishL0). */
  l0Pending: number | undefined;
  /**
   * In-flight ingest: snapshot of seqs being folded, and index into `order`.
   * `null` when host is idle.
   */
  ingest: null | {
    first: number;
    last: number;
    /** Folded value of KEY in the snapshot (undefined if key absent). */
    folded: number | undefined;
    stepIndex: number;
  };
};

export type Action =
  | { type: "append"; value: number }
  | { type: "beginIngest" }
  | { type: "ingestStep"; step: IngestStep }
  | { type: "done" };

export function initialState(): ModelState {
  return {
    wal: [],
    ingestedThrough: 0,
    nextSeq: 1,
    sst: undefined,
    l0Pending: undefined,
    ingest: null,
  };
}

/** Latest WAL put for KEY with seq > ingestedThrough — the mem cell for that key. */
export function walValue(s: ModelState): number | undefined {
  let v: number | undefined;
  for (const r of s.wal) {
    if (r.seq > s.ingestedThrough) v = r.value;
  }
  return v;
}

/**
 * Point read for KEY: the uningested mem cell over SST
 * (`pointGet` on the mem row, else newest SST reader).
 */
export function resolveGet(s: ModelState): number | undefined {
  const local = walValue(s);
  if (local !== undefined) return local;
  return s.sst;
}

/**
 * Every ack'd write for KEY must still be readable until a later append
 * supersedes it. Harm if false: client saw commit succeed, later get misses.
 */
export function noLostAcks(s: ModelState): boolean {
  const expected = latestAcked(s);
  if (expected === undefined) return true;
  return resolveGet(s) === expected;
}

function latestAcked(s: ModelState): number | undefined {
  if (s.wal.length === 0) return undefined;
  // WAL array retains history for bookkeeping; visibility uses ingestedThrough.
  // Ack'd means append completed — including rows already advanced. Those must
  // live in SST (or still in the WAL window).
  let last: number | undefined;
  for (const r of s.wal) last = r.value;
  // After advance, rows stay in `wal` array for history but are invisible via
  // walValue; we need the latest ack across all appends.
  return last;
}

function foldSnapshot(
  wal: readonly WalRec[],
  first: number,
  last: number,
): number | undefined {
  let v: number | undefined;
  for (const r of wal) {
    if (r.seq >= first && r.seq <= last) v = r.value;
  }
  return v;
}

export function enabled(
  s: ModelState,
  order: readonly IngestStep[],
  maxAppends: number,
): Action[] {
  const out: Action[] = [];
  const appendsDone = s.nextSeq - 1;
  // Appends may run while ingest awaits (real host); new seqs stay uningested.
  if (appendsDone < maxAppends) {
    out.push({ type: "append", value: s.nextSeq });
  }
  if (s.ingest === null) {
    const uningested = s.wal.filter((r) => r.seq > s.ingestedThrough);
    if (uningested.length > 0) out.push({ type: "beginIngest" });
  } else if (s.ingest.stepIndex < order.length) {
    out.push({ type: "ingestStep", step: order[s.ingest.stepIndex]! });
  }
  if (
    s.ingest === null &&
    appendsDone >= maxAppends &&
    s.wal.every((r) => r.seq <= s.ingestedThrough)
  ) {
    out.push({ type: "done" });
  }
  return out;
}

export function step(
  s: ModelState,
  a: Action,
  order: readonly IngestStep[],
): ModelState {
  switch (a.type) {
    case "append": {
      const rec: WalRec = { seq: s.nextSeq, value: a.value };
      return {
        ...s,
        wal: [...s.wal, rec],
        nextSeq: s.nextSeq + 1,
      };
    }
    case "beginIngest": {
      const uningested = s.wal.filter((r) => r.seq > s.ingestedThrough);
      if (uningested.length === 0) return s;
      const first = uningested[0]!.seq;
      const last = uningested[uningested.length - 1]!.seq;
      return {
        ...s,
        ingest: {
          first,
          last,
          folded: foldSnapshot(s.wal, first, last),
          stepIndex: 0,
        },
        l0Pending: undefined,
      };
    }
    case "ingestStep": {
      if (!s.ingest) return s;
      const expected = order[s.ingest.stepIndex];
      if (a.step !== expected) return s;
      let next: ModelState = { ...s };
      switch (a.step) {
        case "publishL0":
          // publishL0 writes the SST file; not readable until publishGeneration.
          next = {
            ...s,
            l0Pending: s.ingest.folded,
            ingest: { ...s.ingest, stepIndex: s.ingest.stepIndex + 1 },
          };
          break;
        case "publishGeneration":
          // loadLatestGeneration now sees the new L0 (or pending fold).
          next = {
            ...s,
            sst:
              s.l0Pending !== undefined
                ? s.l0Pending
                : s.ingest.folded !== undefined
                  ? s.ingest.folded
                  : s.sst,
            l0Pending: undefined,
            ingest: { ...s.ingest, stepIndex: s.ingest.stepIndex + 1 },
          };
          break;
        case "advanceIngested":
          next = {
            ...s,
            ingestedThrough: s.ingest.last,
            ingest: { ...s.ingest, stepIndex: s.ingest.stepIndex + 1 },
          };
          break;
        default: {
          const _exhaustive: never = a.step;
          return _exhaustive;
        }
      }
      if (next.ingest && next.ingest.stepIndex >= order.length) {
        next = { ...next, ingest: null };
      }
      return next;
    }
    case "done":
      return s;
    default: {
      const _exhaustive: never = a;
      return _exhaustive;
    }
  }
}

export function encodeState(s: ModelState): string {
  return JSON.stringify(s);
}

export function actionLabel(a: Action): string {
  switch (a.type) {
    case "append":
      return `append(value=${a.value})`;
    case "beginIngest":
      return "beginIngest(listUningested)";
    case "ingestStep":
      return a.step;
    case "done":
      return "done";
    default: {
      const _exhaustive: never = a;
      return _exhaustive;
    }
  }
}

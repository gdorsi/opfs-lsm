import { compareBytes, containsAll, keyToString } from "../../src/bytes.js";

/**
 * The reference model for the kv contract (docs/research/corruption-hardening-test-suite.md,
 * "The contract the tests check"): a gapless log of acked batches and the
 * fold of its prefixes. Every read must equal `fold(log[1..p])` for some
 * `p`, and a reader's `p` never goes backwards.
 */

export type OracleOp =
  | { readonly type: "put"; readonly key: Uint8Array; readonly value: Uint8Array }
  | { readonly type: "del"; readonly key: Uint8Array };

type LogEntry = { readonly seq: number; readonly ops: readonly OracleOp[] };

export type OracleEntry = { readonly key: Uint8Array; readonly value: Uint8Array };

export type OracleRange = {
  readonly start?: Uint8Array;
  readonly endExclusive?: Uint8Array;
  readonly limit?: number;
  readonly valueContains?: readonly Uint8Array[];
};

/** One key's history: the seq of each op on it, and the value it left (undefined for a delete). */
type Version = { readonly seq: number; readonly value: Uint8Array | undefined };

export class Oracle {
  private readonly entries: LogEntry[] = [];
  private readonly versions = new Map<string, { key: Uint8Array; history: Version[] }>();

  /** Seq of the last acked batch. 0 for an empty log. */
  get head(): number {
    return this.entries.length;
  }

  /** Record an acked batch. Returns its seq. An empty batch is not a log entry. */
  append(ops: readonly OracleOp[]): number {
    if (ops.length === 0) throw new Error("oracle: an empty batch has no seq");
    const seq = this.entries.length + 1;
    this.entries.push({ seq, ops: ops.map(copyOp) });
    for (const op of ops) {
      const id = keyToString(op.key);
      let v = this.versions.get(id);
      if (!v) {
        v = { key: new Uint8Array(op.key), history: [] };
        this.versions.set(id, v);
      }
      const value = op.type === "put" ? new Uint8Array(op.value) : undefined;
      const last = v.history[v.history.length - 1];
      // A batch that writes one key twice leaves its last op.
      if (last?.seq === seq) v.history[v.history.length - 1] = { seq, value };
      else v.history.push({ seq, value });
    }
    return seq;
  }

  /** The ops of the batch at `seq`. */
  opsAt(seq: number): readonly OracleOp[] {
    return this.entries[seq - 1]!.ops;
  }

  /** Every key any batch wrote. */
  keys(): Uint8Array[] {
    return [...this.versions.values()].map((v) => v.key);
  }

  /** The value of `key` after `log[1..p]`. */
  valueAt(key: Uint8Array, p = this.head): Uint8Array | undefined {
    const history = this.versions.get(keyToString(key))?.history;
    if (!history) return undefined;
    let out: Uint8Array | undefined;
    for (const v of history) {
      if (v.seq > p) break;
      out = v.value;
    }
    return out;
  }

  /** `fold(log[1..p])` as live entries in key order. */
  stateAt(p = this.head): OracleEntry[] {
    const out: OracleEntry[] = [];
    for (const { key } of this.versions.values()) {
      const value = this.valueAt(key, p);
      if (value !== undefined) out.push({ key, value });
    }
    return out.sort((a, b) => compareBytes(a.key, b.key));
  }

  /** What `range` returns at prefix `p`. */
  rangeAt(range: OracleRange, p = this.head): OracleEntry[] {
    const out = this.stateAt(p).filter(
      ({ key, value }) =>
        (!range.start || compareBytes(key, range.start) >= 0) &&
        (!range.endExclusive || compareBytes(key, range.endExclusive) < 0) &&
        (!range.valueContains || containsAll(value, range.valueContains)),
    );
    return range.limit === undefined ? out : out.slice(0, range.limit);
  }

  /** Every `p` in `[lo, head]` where `get(key)` returns `observed`. */
  getCandidates(key: Uint8Array, observed: Uint8Array | undefined, lo: number): number[] {
    const out: number[] = [];
    for (let p = lo; p <= this.head; p++) {
      if (sameValue(this.valueAt(key, p), observed)) out.push(p);
    }
    return out;
  }

  /** Every `p` in `[lo, head]` where `range` returns `observed`. */
  rangeCandidates(range: OracleRange, observed: readonly OracleEntry[], lo: number): number[] {
    const out: number[] = [];
    for (let p = lo; p <= this.head; p++) {
      if (sameEntries(this.rangeAt(range, p), observed)) out.push(p);
    }
    return out;
  }
}

/**
 * One reader's position in the log (one `Db` handle). `floor` is the lowest
 * prefix its next read may use: it rises with read-your-writes at ack, with
 * `sync()`, and with every read, so `p` never goes backwards.
 */
export class Reader {
  floor = 0;

  constructor(private readonly oracle: Oracle) {}

  /** This reader's write was acked at `seq`: later reads see at least it. */
  acked(seq: number): void {
    this.floor = Math.max(this.floor, seq);
  }

  /** `sync()` resolved: later reads see every seq acked before it was called. */
  synced(headAtCall: number): void {
    this.floor = Math.max(this.floor, headAtCall);
  }

  get(key: Uint8Array, observed: Uint8Array | undefined): void {
    this.settle(this.oracle.getCandidates(key, observed, this.floor), () =>
      `get(${show(key)}) = ${showValue(observed)}; expected ${showValue(this.oracle.valueAt(key))} at head ${this.oracle.head}`,
    );
  }

  range(range: OracleRange, observed: readonly OracleEntry[]): void {
    this.settle(this.oracle.rangeCandidates(range, observed, this.floor), () =>
      `range(${showRange(range)}) = ${showEntries(observed)}; expected ${showEntries(this.oracle.rangeAt(range))} at head ${this.oracle.head}`,
    );
  }

  /**
   * A view's reads, all at one `p`. Each read narrows the candidates;
   * `finish` checks they still meet and moves the floor.
   */
  view(): ViewCheck {
    // The view pins its prefix when it opens. This reader's acks during the
    // callback raise `floor` for later reads, not for the view's.
    const floor = this.floor;
    let candidates: Set<number> | undefined;
    const narrow = (next: number[], what: () => string) => {
      const set = new Set(next);
      candidates = candidates ? new Set([...candidates].filter((p) => set.has(p))) : set;
      if (candidates.size === 0) {
        throw new Error(`view is not one prefix at or after ${floor}: ${what()}`);
      }
    };
    return {
      get: (key, observed) =>
        narrow(this.oracle.getCandidates(key, observed, floor), () =>
          `get(${show(key)}) = ${showValue(observed)}`,
        ),
      range: (range, observed) =>
        narrow(this.oracle.rangeCandidates(range, observed, floor), () =>
          `range(${showRange(range)}) = ${showEntries(observed)}`,
        ),
      finish: () => {
        if (candidates) this.floor = Math.max(this.floor, Math.min(...candidates));
      },
    };
  }

  private settle(candidates: number[], what: () => string): void {
    if (candidates.length === 0) {
      throw new Error(`read is not a prefix at or after ${this.floor}: ${what()}`);
    }
    this.floor = candidates[0]!;
  }
}

export type ViewCheck = {
  get(key: Uint8Array, observed: Uint8Array | undefined): void;
  range(range: OracleRange, observed: readonly OracleEntry[]): void;
  finish(): void;
};

function copyOp(op: OracleOp): OracleOp {
  return op.type === "put"
    ? { type: "put", key: new Uint8Array(op.key), value: new Uint8Array(op.value) }
    : { type: "del", key: new Uint8Array(op.key) };
}

function sameValue(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return compareBytes(a, b) === 0;
}

function sameEntries(a: readonly OracleEntry[], b: readonly OracleEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (compareBytes(a[i]!.key, b[i]!.key) !== 0) return false;
    if (compareBytes(a[i]!.value, b[i]!.value) !== 0) return false;
  }
  return true;
}

const text = new TextDecoder();

/** A key or value for a failure message: text, cut to 24 chars, with its length. */
export function show(bytes: Uint8Array): string {
  const s = text.decode(bytes.subarray(0, 24));
  return `"${s}${bytes.length > 24 ? "…" : ""}"${bytes.length > 24 ? `(${bytes.length}B)` : ""}`;
}

function showValue(v: Uint8Array | undefined): string {
  return v === undefined ? "undefined" : show(v);
}

function showEntries(entries: readonly OracleEntry[]): string {
  return `[${entries.map((e) => `${show(e.key)}=${show(e.value)}`).join(", ")}]`;
}

function showRange(r: OracleRange): string {
  const parts: string[] = [];
  if (r.start) parts.push(`start ${show(r.start)}`);
  if (r.endExclusive) parts.push(`end ${show(r.endExclusive)}`);
  if (r.limit !== undefined) parts.push(`limit ${r.limit}`);
  if (r.valueContains) parts.push(`contains ${r.valueContains.map(show).join("+")}`);
  return parts.join(", ");
}

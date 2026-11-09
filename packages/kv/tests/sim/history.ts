import { compareBytes, containsAll, keyToString } from "../../src/bytes.js";
import { Oracle, show, type OracleEntry, type OracleOp, type OracleRange } from "./oracle.js";

/**
 * A recorded multi-handle history and its seq-exact consistency check
 * (docs/research/corruption-hardening-test-suite.md, technique 5).
 *
 * Every op is recorded with its session (one `Db` handle from open to
 * close), its invocation and response times on one logical clock, and what
 * it returned. Every committed WAL record is recorded with its seq and the
 * op that wrote it. Values are unique, so a read maps back to a prefix of
 * the log, and the check needs no linearizability search.
 *
 * The log is the one order every tab agrees on: by (stamp, tab). The
 * promises it checks, from architecture/wal-opfs/04-per-tab-logs.md
 * ("Guarantees"):
 * - every read is `fold(log[1..p])` for some `p` (the stable prefix), with
 *   the session's own records past `p` applied on top: a tab reads its own
 *   writes at once, before they are stable. Its records acked before the
 *   read are on top; of those still in flight, some first ones may be;
 * - a session's `p` never goes backwards (the stable prefix only grows);
 * - after `sync()` or open resolves, `p >=` every seq acked before the call
 *   (they read every tab's log);
 * - an `update` reads exactly `fold(log[1..s-1])` when it commits at `s`
 *   (it reads at its own stamp, once everything below it is stable);
 * - all reads in one `view` use one `p` and one set of own records;
 * - session order: a write acked before another write of the same session,
 *   or of a session that ran `sync()` or open in between, has the smaller
 *   seq (stamps rise, and above every stamp the tab has seen).
 *
 * Not checked, because session puts do not promise it: that writes of two
 * tabs that did not see each other are in real-time order, or that a read
 * on one handle sees another handle's write acked before the read without
 * a `sync()` in between.
 */

export type ViewRead =
  | { readonly kind: "get"; readonly key: Uint8Array; readonly value: Uint8Array | undefined }
  | { readonly kind: "range"; readonly range: OracleRange; readonly entries: readonly OracleEntry[] };

type Base = {
  readonly id: number;
  readonly session: number;
  readonly invoke: number;
  response?: number;
  error?: unknown;
};

export type HistOp = Base &
  (
    | { readonly kind: "open" | "close" | "sync" | "ingest" }
    | { readonly kind: "write"; readonly ops: readonly OracleOp[] }
    | {
        readonly kind: "update";
        readonly keys: readonly Uint8Array[];
        /** What the body saw on its last run. */
        seen?: readonly (Uint8Array | undefined)[];
        /** What the body wrote on its last run. */
        ops: readonly OracleOp[];
      }
    | { readonly kind: "get"; readonly key: Uint8Array; value?: Uint8Array | undefined }
    | { readonly kind: "range"; readonly range: OracleRange; entries?: readonly OracleEntry[] }
    | { readonly kind: "view"; readonly reads: ViewRead[] }
  );

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type NewOp = DistributiveOmit<HistOp, "id" | "invoke" | "response" | "error">;
export type OpOf<K extends HistOp["kind"]> = Extract<HistOp, { kind: K }>;

type Commit = { readonly seq: number; readonly ops: readonly OracleOp[]; readonly op: number | undefined };

export class History {
  private clock = 0;
  private sessions = 0;
  readonly ops: HistOp[] = [];
  private readonly commits: Commit[] = [];

  newSession(): number {
    return ++this.sessions;
  }

  invoke<T extends NewOp>(op: T): OpOf<T["kind"]> {
    const out = { ...op, id: this.ops.length + 1, invoke: ++this.clock } as unknown as OpOf<T["kind"]>;
    this.ops.push(out);
    return out;
  }

  respond(op: HistOp, error?: unknown): void {
    op.response = ++this.clock;
    if (error !== undefined) op.error = error;
  }

  /** A WAL record committed at the next seq. `op` is the op that wrote it, when known. */
  commit(op: number | undefined, ops: readonly OracleOp[], seq = this.commits.length + 1): number {
    this.commits.push({ seq, ops: ops.map(copyOp), op });
    return seq;
  }

  /** The log as an oracle. Throws unless the seqs are exactly 1..n. */
  oracle(): Oracle {
    const oracle = new Oracle();
    const sorted = [...this.commits].sort((a, b) => a.seq - b.seq);
    sorted.forEach((c, i) => {
      if (c.seq !== i + 1) throw new Error(`committed seqs are not gapless: ${sorted.map((x) => x.seq).join(",")}`);
      oracle.append(c.ops);
    });
    return oracle;
  }

  seqOf(op: number): number | undefined {
    return this.commits.find((c) => c.op === op)?.seq;
  }

  /** The op that wrote `seq`. */
  writerOf(seq: number): HistOp | undefined {
    const id = this.commits.find((c) => c.seq === seq)?.op;
    return id === undefined ? undefined : this.ops[id - 1];
  }

  format(): string {
    const lines: string[] = [];
    for (const op of this.ops) {
      const seq = this.seqOf(op.id);
      lines.push(
        `#${op.id} s${op.session} [${op.invoke}..${op.response ?? "?"}] ${describe(op)}` +
          (seq !== undefined ? ` @seq ${seq}` : "") +
          (op.error !== undefined ? ` !${errorName(op.error)}: ${errorMessage(op.error)}` : ""),
      );
    }
    return lines.join("\n");
  }
}

/** Throws with the history attached when it breaks a promise listed above. */
export function checkHistory(h: History): Oracle {
  try {
    return check(h);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${msg}\n--- history (seq is the WAL record the op committed) ---\n${h.format()}`);
  }
}

function check(h: History): Oracle {
  const oracle = h.oracle();
  const ops = h.ops;
  const seq = new Map<number, number>();
  for (const op of ops) {
    const s = h.seqOf(op.id);
    if (s !== undefined) seq.set(op.id, s);
  }
  const closedAt = new Map<number, number>();
  for (const op of ops) if (op.kind === "close") closedAt.set(op.session, Math.min(closedAt.get(op.session) ?? Infinity, op.invoke));

  // Errors: only an op whose handle closed under it may fail, and never as corruption.
  for (const op of ops) {
    if (op.response === undefined) throw new Error(`#${op.id} ${describe(op)} never settled`);
    if (op.error === undefined) continue;
    const closing = (closedAt.get(op.session) ?? Infinity) < op.response;
    if (errorName(op.error) === "CorruptDatabaseError" || !closing) {
      throw new Error(`#${op.id} ${describe(op)} failed: ${errorName(op.error)}: ${errorMessage(op.error)}`);
    }
  }

  const acked = ops.filter((op) => op.error === undefined && seq.has(op.id));
  /** The newest seq acked anywhere before time `t`. */
  const ackedBefore = (t: number) => Math.max(0, ...acked.filter((w) => w.response! < t).map((w) => seq.get(w.id)!));

  /** A sync or open on `session` that started after `from` and returned before `to`. */
  const barrier = (session: number, from: number, to: number) =>
    ops.some(
      (o) => (o.kind === "sync" || o.kind === "open") && o.session === session && o.error === undefined && o.invoke > from && o.response! < to,
    );
  for (const a of acked) {
    for (const b of acked) {
      if (a.response! < b.invoke && seq.get(a.id)! > seq.get(b.id)! && (a.session === b.session || barrier(b.session, a.response!, b.invoke))) {
        throw new Error(
          `session order: #${a.id} acked at seq ${seq.get(a.id)} before #${b.id} was invoked${a.session === b.session ? " on its session" : " and synced"}, but #${b.id} got seq ${seq.get(b.id)}`,
        );
      }
    }
  }

  /** Per session, its records: seq, and the op that wrote them. */
  const own = new Map<number, { seq: number; op: HistOp }[]>();
  for (let s = 1; s <= oracle.head; s++) {
    const w = h.writerOf(s);
    if (!w) continue;
    own.set(w.session, [...(own.get(w.session) ?? []), { seq: s, op: w }]);
  }
  /**
   * The own records a read may have on top of its prefix: those acked
   * before it, and some first ones of those in flight. Each choice is one
   * list of seqs.
   */
  const ownChoices = (r: HistOp): number[][] => {
    const mine = own.get(r.session) ?? [];
    const must = mine.filter((m) => m.op.response! < r.invoke).map((m) => m.seq);
    const maybe = mine.filter((m) => !(m.op.response! < r.invoke) && m.op.invoke < r.response!).map((m) => m.seq);
    return Array.from({ length: maybe.length + 1 }, (_, k) => [...must, ...maybe.slice(0, k)].sort((x, y) => x - y));
  };

  /** A read cannot see a write that was not invoked when the read returned. */
  const upper = (t: number) => {
    for (let s = 1; s <= oracle.head; s++) {
      const w = h.writerOf(s);
      if (w && w.invoke > t) return s - 1;
    }
    return oracle.head;
  };

  const prefix = new Map<number, number>();
  for (const r of ops) {
    if (r.error !== undefined) continue;
    if (r.kind !== "get" && r.kind !== "range" && r.kind !== "view" && r.kind !== "update") continue;
    const before = ops.filter((o) => o.session === r.session && o.error === undefined && o.response! < r.invoke);
    const bounds: { lo: number; why: string }[] = [{ lo: 0, why: "start" }];
    for (const o of before) {
      const p = prefix.get(o.id);
      if (p !== undefined) bounds.push({ lo: p, why: `#${o.id} read prefix ${p} (prefix never goes backwards)` });
      if (o.kind === "sync" || o.kind === "open") {
        bounds.push({ lo: ackedBefore(o.invoke), why: `#${o.id} ${o.kind} barrier` });
      }
    }
    const floor = bounds.reduce((a, b) => (b.lo > a.lo ? b : a));
    const lo = floor.lo;
    const hi = upper(r.response!);
    const within = (ps: number[]) => ps.filter((p) => p <= hi);
    const fail = (what: string) =>
      new Error(
        `#${r.id} ${describe(r)}: ${what}; not the fold of any log prefix in [${lo}, ${hi}] ` +
          `(floor from ${floor.why}; head ${oracle.head})`,
      );

    const choices = ownChoices(r);
    /** The prefixes in `[lo, hi]` where every read in `reads` holds, with one choice of own records. */
    const fits = (reads: readonly ViewRead[]): number[] => {
      const out: number[] = [];
      for (let p = lo; p <= hi; p++) {
        if (choices.some((c) => reads.every((read) => holds(oracle, read, p, c)))) out.push(p);
      }
      return out;
    };

    let candidates: number[];
    if (r.kind === "get") {
      candidates = fits([{ kind: "get", key: r.key, value: r.value }]);
      if (candidates.length === 0) {
        throw fail(`saw ${showValue(r.value)}, value at head is ${showValue(oracle.valueAt(r.key))}`);
      }
    } else if (r.kind === "range") {
      candidates = fits([{ kind: "range", range: r.range, entries: r.entries! }]);
      if (candidates.length === 0) {
        throw fail(`saw ${showEntries(r.entries!)}, head has ${showEntries(oracle.rangeAt(r.range))}`);
      }
    } else if (r.kind === "view") {
      candidates = r.reads.length > 0 ? fits(r.reads) : [lo];
      if (candidates.length === 0) throw fail(`view is not one prefix: ${r.reads.map(showRead).join("; ")}`);
    } else {
      const s = seq.get(r.id);
      const seen = r.seen ?? [];
      if (s !== undefined) {
        // Committed at s: it read exactly the state before s.
        r.keys.forEach((k, i) => {
          const want = oracle.valueAt(k, s - 1);
          if (!sameValue(seen[i], want)) {
            throw fail(`update committed at seq ${s} but read ${show(k)} = ${showValue(seen[i])}, not ${showValue(want)} (a lost update)`);
          }
        });
        if (s - 1 < lo) throw fail(`update committed at seq ${s}, below its floor`);
        candidates = [s - 1];
      } else {
        // It wrote nothing: it still read one prefix, with nothing of its own on top.
        let set: number[] | undefined;
        r.keys.forEach((k, i) => {
          const next = oracle.getCandidates(k, seen[i], lo);
          set = within(set ? set.filter((p) => next.includes(p)) : next);
        });
        if (set !== undefined && set.length === 0) throw fail("update read is not one prefix");
        candidates = set ?? [lo];
      }
    }
    prefix.set(r.id, candidates[0]!);
  }
  return oracle;
}

/** Whether `read` returns what `fold(log[1..p])` with the own records `mine` past `p` on top does. */
function holds(oracle: Oracle, read: ViewRead, p: number, mine: readonly number[]): boolean {
  const over = mine.filter((s) => s > p);
  if (read.kind === "get") {
    let value = oracle.valueAt(read.key, p);
    for (const s of over) for (const op of oracle.opsAt(s)) if (compareBytes(op.key, read.key) === 0) value = op.type === "put" ? op.value : undefined;
    return sameValue(value, read.value);
  }
  if (over.length === 0) return sameEntries(oracle.rangeAt(read.range, p), read.entries);
  const state = new Map<string, OracleEntry>();
  for (const e of oracle.stateAt(p)) state.set(keyToString(e.key), e);
  for (const s of over) {
    for (const op of oracle.opsAt(s)) {
      if (op.type === "put") state.set(keyToString(op.key), { key: op.key, value: op.value });
      else state.delete(keyToString(op.key));
    }
  }
  const range = read.range;
  const all = [...state.values()]
    .sort((a, b) => compareBytes(a.key, b.key))
    .filter(
      ({ key, value }) =>
        (!range.start || compareBytes(key, range.start) >= 0) &&
        (!range.endExclusive || compareBytes(key, range.endExclusive) < 0) &&
        (!range.valueContains || containsAll(value, range.valueContains)),
    );
  return sameEntries(range.limit === undefined ? all : all.slice(0, range.limit), read.entries);
}

function sameEntries(a: readonly OracleEntry[], b: readonly OracleEntry[]): boolean {
  return a.length === b.length && a.every((e, i) => compareBytes(e.key, b[i]!.key) === 0 && sameValue(e.value, b[i]!.value));
}

function showRead(read: ViewRead): string {
  return read.kind === "get" ? `get ${show(read.key)} = ${showValue(read.value)}` : `range ${showRange(read.range)} = ${showEntries(read.entries)}`;
}

function copyOp(op: OracleOp): OracleOp {
  return op.type === "put"
    ? { type: "put", key: new Uint8Array(op.key), value: new Uint8Array(op.value) }
    : { type: "del", key: new Uint8Array(op.key) };
}

function sameValue(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function showValue(v: Uint8Array | undefined): string {
  return v === undefined ? "undefined" : show(v);
}

function showEntries(entries: readonly OracleEntry[]): string {
  return `[${entries.map((e) => `${show(e.key)}=${show(e.value)}`).join(", ")}]`;
}

function showOps(ops: readonly OracleOp[]): string {
  return ops.map((o) => (o.type === "put" ? `put ${show(o.key)}=${show(o.value)}` : `del ${show(o.key)}`)).join("; ");
}

function showRange(r: OracleRange): string {
  return JSON.stringify({
    ...(r.start ? { start: new TextDecoder().decode(r.start.subarray(0, 12)) } : {}),
    ...(r.endExclusive ? { end: new TextDecoder().decode(r.endExclusive.subarray(0, 12)) } : {}),
    ...(r.limit !== undefined ? { limit: r.limit } : {}),
    ...(r.valueContains ? { contains: r.valueContains.map((c) => new TextDecoder().decode(c)) } : {}),
  });
}

function describe(op: HistOp): string {
  switch (op.kind) {
    case "open":
    case "close":
    case "sync":
    case "ingest":
      return op.kind;
    case "write":
      return op.ops.length > 3 ? `batch of ${op.ops.length} ops` : `write[${showOps(op.ops)}]`;
    case "update":
      return `update[${op.keys.map(show).join(", ")}] saw [${(op.seen ?? []).map(showValue).join(", ")}] wrote [${showOps(op.ops)}]`;
    case "get":
      return `get ${show(op.key)} = ${showValue(op.value)}`;
    case "range":
      return `range ${showRange(op.range)} = ${op.entries ? showEntries(op.entries) : "?"}`;
    case "view":
      return `view[${op.reads
        .map((r) => (r.kind === "get" ? `get ${show(r.key)} = ${showValue(r.value)}` : `range ${showRange(r.range)} = ${showEntries(r.entries)}`))
        .join("; ")}]`;
  }
}

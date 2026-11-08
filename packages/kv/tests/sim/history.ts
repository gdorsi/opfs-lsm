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
 * The promises it checks, all from docs/design.md:
 * - every read is `fold(log[1..p])` for some `p` ("Consistency");
 * - a session's `p` never goes backwards (the memtable is one exact prefix
 *   that only grows, "Memtable");
 * - after a write's ack at seq `s`, the writer's reads use `p >= s` ("At the
 *   ack, the writer sees its own write and every earlier one", "Append");
 * - after `sync()` or open resolves, `p >=` every seq acked before the call
 *   ("Seeing other tabs' writes"; open runs `sync`);
 * - an `update` reads exactly `fold(log[1..s-1])` when it commits at `s` ("No
 *   other write can land between the reads and the commit"), and when it
 *   writes nothing it still caught up inside its transaction;
 * - all reads in one `view` use one `p` ("pinned WAL head");
 * - a write acked before another is invoked has the smaller seq (the WAL
 *   serializes appends; seqs are the log order).
 *
 * Not checked, because the docs do not promise it: that a read on one
 * handle sees another handle's write acked before the read, without a
 * `sync()` in between. "A tab sees another tab's write a moment after that
 * write's ack, not at it."
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

  for (const a of acked) {
    for (const b of acked) {
      if (a.response! < b.invoke && seq.get(a.id)! > seq.get(b.id)!) {
        throw new Error(
          `real-time order: #${a.id} acked at seq ${seq.get(a.id)} before #${b.id} was invoked, but #${b.id} got seq ${seq.get(b.id)}`,
        );
      }
    }
  }

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
      const s = seq.get(o.id);
      if (s !== undefined) bounds.push({ lo: s, why: `#${o.id} acked at seq ${s} (read-your-writes)` });
      if (o.kind === "sync" || o.kind === "open") {
        bounds.push({ lo: ackedBefore(o.invoke), why: `#${o.id} ${o.kind} barrier` });
      }
    }
    if (r.kind === "update") bounds.push({ lo: ackedBefore(r.invoke), why: "update catches up inside its transaction" });
    const floor = bounds.reduce((a, b) => (b.lo > a.lo ? b : a));
    const lo = floor.lo;
    const hi = upper(r.response!);
    const within = (ps: number[]) => ps.filter((p) => p <= hi);
    const fail = (what: string) =>
      new Error(
        `#${r.id} ${describe(r)}: ${what}; not the fold of any log prefix in [${lo}, ${hi}] ` +
          `(floor from ${floor.why}; head ${oracle.head})`,
      );

    let candidates: number[];
    if (r.kind === "get") {
      candidates = within(oracle.getCandidates(r.key, r.value, lo));
      if (candidates.length === 0) {
        throw fail(`saw ${showValue(r.value)}, value at head is ${showValue(oracle.valueAt(r.key))}`);
      }
    } else if (r.kind === "range") {
      candidates = within(oracle.rangeCandidates(r.range, r.entries!, lo));
      if (candidates.length === 0) {
        throw fail(`saw ${showEntries(r.entries!)}, head has ${showEntries(oracle.rangeAt(r.range))}`);
      }
    } else if (r.kind === "view") {
      let set: number[] | undefined;
      for (const read of r.reads) {
        const next =
          read.kind === "get"
            ? oracle.getCandidates(read.key, read.value, lo)
            : oracle.rangeCandidates(read.range, read.entries, lo);
        set = within(set ? set.filter((p) => next.includes(p)) : next);
        if (set.length === 0) {
          throw fail(
            `view is not one prefix at read ${read.kind === "get" ? `get ${show(read.key)} = ${showValue(read.value)}` : `range = ${showEntries(read.entries)}`}`,
          );
        }
      }
      candidates = set ?? [lo];
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

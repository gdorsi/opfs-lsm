import { applyRange, Oracle, show, type OracleEntry, type OracleOp, type OracleRange } from "./oracle.js";

/**
 * A recorded multi-handle history and its consistency check
 * (docs/research/corruption-hardening-test-suite.md, technique 5).
 *
 * Every op is recorded with its session (one `Db` handle from open to
 * close), its invocation and response times on one logical clock, and what
 * it returned. Every acked record is recorded with its session, its log and
 * n, and the op that wrote it; every record the host ingests is recorded
 * with its ingest seq. Values are unique, so a read maps back to a state,
 * and the check needs no linearizability search.
 *
 * A page reads `fold(ingest[1..p])` for an installed manifest's `p`, with
 * its own first `k` acked records that `p` does not cover on top. The
 * promises it checks:
 * - every read is such a state `(p, k)`, with `p` a manifest boundary;
 * - a session's `p` and `k` never go backwards;
 * - after a write's ack, the writer's reads hold it (`k` covers it);
 * - after `sync()`, `ingest()` or open resolves, `p` covers every record
 *   acked anywhere before the call;
 * - all reads in one `view` use one state;
 * - an `update` reads one state that holds every earlier write of its page,
 *   acked or not. Updates of different pages are last-writer-wins: an
 *   increment can be lost, and that is the contract;
 * - each page's records are ingested in its ack order, every acked record
 *   is ingested exactly once, with the ops it acked.
 *
 * Not checked, because nothing promises it: that a read on one handle sees
 * another handle's write acked before the read, without a barrier between.
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

/** A record its page acked. `index` is its place in the page's ack order, from 1. */
type Acked = {
  readonly session: number;
  readonly op: number | undefined;
  readonly log: string;
  readonly n: number;
  readonly ops: readonly OracleOp[];
  readonly index: number;
};

type Planned = { readonly log: string; readonly n: number; readonly ops: readonly OracleOp[] };

const recKey = (log: string, n: number) => `${log}/${n}`;

export class History {
  private clock = 0;
  private sessions = 0;
  readonly ops: HistOp[] = [];
  readonly acks: Acked[] = [];
  private readonly planned = new Map<number, Planned>();
  private readonly boundaries = new Set<number>([0]);

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

  /** `session` acked record `n` of `log`. `op` wrote it, when known. */
  acked(session: number, op: number | undefined, log: string, n: number, ops: readonly OracleOp[]): void {
    const index = this.acks.filter((a) => a.session === session).length + 1;
    this.acks.push({ session, op, log, n, ops: ops.map(copyOp), index });
  }

  /**
   * The host planned record `n` of `log` at ingest seq `seq`. A plan that
   * was not published is planned again from the same base, so a later plan
   * overwrites the seqs an earlier one gave.
   */
  plan(seq: number, log: string, n: number, ops: readonly OracleOp[]): void {
    this.planned.set(seq, { log, n, ops: ops.map(copyOp) });
  }

  /** A manifest may hold seqs 1..through. */
  boundary(through: number): void {
    this.boundaries.add(through);
  }

  /** The ingest log through `through`, the seq of each record in it, and the boundaries up to it. */
  ingested(through: number): { oracle: Oracle; seqOf: Map<string, number>; boundaries: number[] } {
    const oracle = new Oracle();
    const seqOf = new Map<string, number>();
    for (let seq = 1; seq <= through; seq++) {
      const rec = this.planned.get(seq);
      if (!rec) throw new Error(`ingest seq ${seq} has no planned record`);
      const key = recKey(rec.log, rec.n);
      if (seqOf.has(key)) throw new Error(`record ${key} ingested twice, at seqs ${seqOf.get(key)} and ${seq}`);
      seqOf.set(key, seq);
      oracle.append(rec.ops);
    }
    const boundaries = [...this.boundaries].filter((b) => b <= through).sort((a, b) => a - b);
    return { oracle, seqOf, boundaries };
  }

  format(seqs: ReadonlyMap<string, number> = new Map()): string {
    const lines: string[] = [];
    for (const op of this.ops) {
      const a = this.acks.find((x) => x.op === op.id);
      const seq = a && seqs.get(recKey(a.log, a.n));
      lines.push(
        `#${op.id} s${op.session} [${op.invoke}..${op.response ?? "?"}] ${describe(op)}` +
          (a ? ` @${a.log.slice(0, 8)}/${a.n} own ${a.index}` : "") +
          (seq !== undefined ? ` seq ${seq}` : "") +
          (op.error !== undefined ? ` !${errorName(op.error)}: ${errorMessage(op.error)}` : ""),
      );
    }
    return lines.join("\n");
  }
}

/** Throws with the history attached when it breaks a promise listed above. Returns the ingest log. */
export function checkHistory(h: History, through: number): Oracle {
  let seqs = new Map<string, number>();
  try {
    const ingested = h.ingested(through);
    seqs = ingested.seqOf;
    check(h, ingested.oracle, ingested.seqOf, ingested.boundaries);
    return ingested.oracle;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${msg}\n--- history (log/n: the record the op acked; own: its place in the page's ack order) ---\n${h.format(seqs)}`);
  }
}

/** A read state: ingest prefix `p`, and the page's first `k` acked records on top. */
type State = { readonly p: number; readonly k: number };

function check(h: History, oracle: Oracle, seqOf: ReadonlyMap<string, number>, boundaries: readonly number[]): void {
  const ops = h.ops;
  const byId = (id: number | undefined) => (id === undefined ? undefined : ops[id - 1]);
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

  // Every acked record is ingested once, as acked, and each page's in its ack order.
  const seqOfAck = new Map<Acked, number>();
  const lastSeq = new Map<number, number>();
  for (const a of h.acks) {
    const seq = seqOf.get(recKey(a.log, a.n));
    if (seq === undefined) throw new Error(`s${a.session}'s acked record ${a.log}/${a.n} (#${a.op}) was never ingested`);
    if (!sameOps(oracle.opsAt(seq), a.ops)) throw new Error(`seq ${seq} holds other ops than s${a.session} acked as ${a.log}/${a.n}`);
    if (seq < (lastSeq.get(a.session) ?? 0)) throw new Error(`s${a.session}'s record ${a.log}/${a.n} ingested at seq ${seq}, before a record it acked earlier`);
    lastSeq.set(a.session, seq);
    seqOfAck.set(a, seq);
  }

  /** The newest seq of a record acked anywhere before time `t`. */
  const ackedBefore = (t: number) =>
    Math.max(0, ...h.acks.filter((a) => (byId(a.op)?.response ?? Infinity) < t).map((a) => seqOfAck.get(a)!));

  /** The newest boundary whose records were all invoked before `t`. */
  const upper = (t: number) => {
    let hi = 0;
    const writerOf = new Map<number, Acked>();
    for (const a of h.acks) writerOf.set(seqOfAck.get(a)!, a);
    for (const b of boundaries) {
      let ok = true;
      for (let s = hi + 1; s <= b && ok; s++) {
        const w = byId(writerOf.get(s)?.op);
        if (w && w.invoke > t) ok = false;
      }
      if (!ok) break;
      hi = b;
    }
    return hi;
  };

  const stateCache = new Map<number, OracleEntry[]>();
  const stateAtP = (p: number) => {
    let s = stateCache.get(p);
    if (!s) stateCache.set(p, (s = oracle.stateAt(p)));
    return s;
  };

  const floors = new Map<number, State>();
  for (const r of ops) {
    if (r.error !== undefined) continue;
    if (r.kind !== "get" && r.kind !== "range" && r.kind !== "view" && r.kind !== "update") continue;
    const own = h.acks.filter((a) => a.session === r.session);
    const before = ops.filter((o) => o.session === r.session && o.error === undefined && o.response! < r.invoke);

    const pBounds: { lo: number; why: string }[] = [{ lo: 0, why: "start" }];
    const kBounds: { lo: number; why: string }[] = [{ lo: 0, why: "start" }];
    for (const o of before) {
      const f = floors.get(o.id);
      if (f) {
        pBounds.push({ lo: f.p, why: `#${o.id} read prefix ${f.p} (never goes backwards)` });
        kBounds.push({ lo: f.k, why: `#${o.id} read ${f.k} own records (never goes backwards)` });
      }
      const mine = own.find((a) => a.op === o.id);
      if (mine) kBounds.push({ lo: mine.index, why: `#${o.id} acked as own record ${mine.index} (read your writes)` });
      if (o.kind === "sync" || o.kind === "open" || o.kind === "ingest") {
        pBounds.push({ lo: ackedBefore(o.invoke), why: `#${o.id} ${o.kind} barrier` });
      }
    }
    if (r.kind === "update") {
      for (const a of own) {
        const w = byId(a.op);
        if (w && w.invoke < r.invoke) kBounds.push({ lo: a.index, why: `#${w.id} was invoked before the update (an update sees its page's writes)` });
      }
    }
    const pFloor = pBounds.reduce((a, b) => (b.lo > a.lo ? b : a));
    const kFloor = kBounds.reduce((a, b) => (b.lo > a.lo ? b : a));
    const pHi = upper(r.response!);
    const kHi = Math.max(0, ...own.filter((a) => (byId(a.op)?.invoke ?? 0) < r.response!).map((a) => a.index));
    const ps = boundaries.filter((b) => b >= pFloor.lo && b <= pHi);
    let candidates: State[] = [];
    for (const p of ps) for (let k = kFloor.lo; k <= kHi; k++) candidates.push({ p, k });

    /** Own records of `k` that `p` does not cover, in ack order. */
    const onTop = ({ p, k }: State) => own.filter((a) => a.index <= k && seqOfAck.get(a)! > p);
    const valueAt = (key: Uint8Array, st: State) => {
      let v = oracle.valueAt(key, st.p);
      for (const a of onTop(st)) for (const op of a.ops) if (sameKey(op.key, key)) v = op.type === "put" ? op.value : undefined;
      return v;
    };
    const rangeAt = (range: OracleRange, st: State) => {
      const map = new Map(stateAtP(st.p).map((e) => [show(e.key), e as { key: Uint8Array; value: Uint8Array | undefined }]));
      for (const a of onTop(st)) for (const op of a.ops) map.set(show(op.key), { key: op.key, value: op.type === "put" ? op.value : undefined });
      const live = [...map.values()].filter((e): e is OracleEntry => e.value !== undefined);
      return applyRange(live, range);
    };
    const fail = (what: string) =>
      new Error(
        `#${r.id} ${describe(r)}: ${what}; no state with p in [${pFloor.lo}, ${pHi}] (floor from ${pFloor.why}) and ` +
          `own k in [${kFloor.lo}, ${kHi}] (floor from ${kFloor.why}) reads this; boundaries ${ps.join(",")}`,
      );
    const narrow = (keep: (st: State) => boolean, what: () => string) => {
      candidates = candidates.filter(keep);
      if (candidates.length === 0) throw fail(what());
    };

    if (r.kind === "get") {
      narrow((st) => sameValue(valueAt(r.key, st), r.value), () => `saw ${showValue(r.value)}, value at head is ${showValue(oracle.valueAt(r.key))}`);
    } else if (r.kind === "range") {
      narrow((st) => sameEntries(rangeAt(r.range, st), r.entries!), () => `saw ${showEntries(r.entries!)}, head has ${showEntries(oracle.rangeAt(r.range))}`);
    } else if (r.kind === "view") {
      for (const read of r.reads) {
        if (read.kind === "get") narrow((st) => sameValue(valueAt(read.key, st), read.value), () => `view is not one state at get ${show(read.key)} = ${showValue(read.value)}`);
        else narrow((st) => sameEntries(rangeAt(read.range, st), read.entries), () => `view is not one state at range = ${showEntries(read.entries)}`);
      }
    } else {
      const seen = r.seen ?? [];
      r.keys.forEach((k, i) =>
        narrow((st) => sameValue(valueAt(k, st), seen[i]), () => `update read ${show(k)} = ${showValue(seen[i])}, not one state`),
      );
    }
    if (candidates.length === 0) throw fail("no candidate state");
    floors.set(r.id, { p: Math.min(...candidates.map((c) => c.p)), k: Math.min(...candidates.map((c) => c.k)) });
  }
}

function copyOp(op: OracleOp): OracleOp {
  return op.type === "put"
    ? { type: "put", key: new Uint8Array(op.key), value: new Uint8Array(op.value) }
    : { type: "del", key: new Uint8Array(op.key) };
}

function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function sameValue(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return sameKey(a, b);
}

function sameEntries(a: readonly OracleEntry[], b: readonly OracleEntry[]): boolean {
  return a.length === b.length && a.every((e, i) => sameKey(e.key, b[i]!.key) && sameKey(e.value, b[i]!.value));
}

function sameOps(a: readonly OracleOp[], b: readonly OracleOp[]): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => {
      const y = b[i]!;
      return x.type === y.type && sameKey(x.key, y.key) && (x.type === "del" || (y.type === "put" && sameKey(x.value, y.value)));
    })
  );
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
    ...(r.reverse ? { reverse: true } : {}),
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

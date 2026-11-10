import type { WorkOp } from "./kill-chrome-workload.ts";

/**
 * Assign the seqs the kill loop did not see acked. A value names the attempt
 * that wrote it (`kill-chrome-workload.ts`), so the last put of a key fixes
 * which attempt is included and that nothing later touches the key. The
 * search follows those pins. Without them a browser crash of a fast append
 * leaves more committed-but-unacked seqs than a blind 3^n search can finish.
 */

export type KillApplied = { seq: number; ops: readonly WorkOp[] };

export type KillTail = { lastSeq: number; next: readonly (readonly WorkOp[])[] };

export type KillVerdict =
  | { ok: true; unknown: number; assignments: number }
  | { ok: false; reason: string; detail: string[] };

const MAX_ASSIGNMENTS = 200_000;

function fold(base: ReadonlyMap<string, string>, log: readonly KillApplied[]): Map<string, string> {
  const out = new Map(base);
  for (const { ops } of [...log].sort((a, b) => a.seq - b.seq)) {
    for (const op of ops) {
      if (op.type === "put") out.set(op.key, op.value);
      else out.delete(op.key);
    }
  }
  return out;
}

function short(v: string | undefined): string {
  if (v === undefined) return "(none)";
  return v.split("|")[0] ?? v;
}

/** The last effect of `ops` on `key`, or undefined when `ops` does not touch it. */
function net(ops: readonly WorkOp[], key: string): { touched: false } | { touched: true; value: string | undefined } {
  let touched = false;
  let value: string | undefined;
  for (const op of ops) {
    if (op.key !== key) continue;
    touched = true;
    value = op.type === "put" ? op.value : undefined;
  }
  return touched ? { touched, value } : { touched };
}

type Writer =
  | { readonly kind: "known"; readonly seq: number }
  | { readonly kind: "tail"; readonly tab: number; readonly index: number };

/**
 * Find an assignment of the unseen seqs `(baseHead, head]` to in-flight
 * attempts (each tab's next attempts, in order, after its last seen ack)
 * whose fold equals `observed`.
 */
export function verifyKillState(
  base: ReadonlyMap<string, string>,
  baseHead: number,
  head: number,
  known: readonly KillApplied[],
  tails: readonly KillTail[],
  observed: ReadonlyMap<string, string>,
): KillVerdict {
  const seen = new Set<number>();
  for (const k of known) {
    if (seen.has(k.seq)) return { ok: false, reason: "two acks with one seq", detail: [`seq ${k.seq}`] };
    seen.add(k.seq);
    if (k.seq <= baseHead) return { ok: false, reason: "ack seq at or below the previous head", detail: [`seq ${k.seq}, previous head ${baseHead}`] };
    if (k.seq > head) return { ok: false, reason: "acked write lost: seq past the recovered head", detail: [`seq ${k.seq}, head ${head}`] };
  }
  const unknown: number[] = [];
  for (let s = baseHead + 1; s <= head; s++) if (!seen.has(s)) unknown.push(s);

  const touched = new Set<string>();
  for (const t of tails) for (const ops of t.next.slice(0, unknown.length)) for (const op of ops) touched.add(op.key);
  const fixed = fold(base, known);
  const diff: string[] = [];
  for (const key of new Set([...fixed.keys(), ...observed.keys()])) {
    if (touched.has(key)) continue;
    if (fixed.get(key) !== observed.get(key)) diff.push(`${key}: read ${short(observed.get(key))}, log says ${short(fixed.get(key))}`);
  }
  if (diff.length > 0) return { ok: false, reason: "state is not the fold of the acked log", detail: diff.slice(0, 12) };

  const knownTouch = new Map<string, number>();
  for (const k of known) for (const op of k.ops) knownTouch.set(op.key, Math.max(knownTouch.get(op.key) ?? 0, k.seq));

  const lastWriter = new Map<string, Writer>();
  const minLen = tails.map(() => 0);
  for (const key of touched) {
    const want = observed.get(key);
    if (want === undefined || want === fixed.get(key)) continue;
    const writer = findPut(want, known, tails, unknown.length);
    if (writer === "many") continue;
    if (!writer) {
      return {
        ok: false,
        reason: "read value was not written by an acked or in-flight attempt",
        detail: [`${key}: read ${short(want)}`],
      };
    }
    lastWriter.set(key, writer);
    if (writer.kind === "tail") minLen[writer.tab] = Math.max(minLen[writer.tab]!, writer.index + 1);
  }
  const pinned = minLen.reduce((n, k) => n + k, 0);
  if (pinned > unknown.length) {
    return {
      ok: false,
      reason: `no assignment of ${unknown.length} unseen seqs to in-flight attempts gives the read state`,
      detail: [`the values need ${pinned} in-flight attempts`],
    };
  }

  let tried = 0;
  const used = tails.map(() => 0);
  const lastSeq = tails.map((t) => t.lastSeq);
  const chosen: KillApplied[] = [];
  const writerSeq = new Map<string, number>();

  const matches = (): boolean => {
    const state = fold(base, [...known, ...chosen]);
    for (const key of touched) if (state.get(key) !== observed.get(key)) return false;
    return true;
  };
  const stillPossible = (slot: number): boolean => {
    let need = 0;
    for (let t = 0; t < minLen.length; t++) need += Math.max(0, minLen[t]! - used[t]!);
    return need <= unknown.length - slot;
  };
  const clobbers = (tab: number, ops: readonly WorkOp[], seq: number): boolean => {
    for (const op of ops) {
      const writer = lastWriter.get(op.key);
      if (!writer) continue;
      if (writer.kind === "known") {
        if (seq > writer.seq) return true;
        continue;
      }
      if (tab === writer.tab && used[tab] === writer.index) {
        if (seq <= (knownTouch.get(op.key) ?? 0)) return true;
        continue;
      }
      const placed = writerSeq.get(op.key);
      if (placed !== undefined && seq > placed) return true;
      if (tab === writer.tab && used[tab]! > writer.index) return true;
    }
    return false;
  };

  const search = (slot: number): boolean => {
    if (slot === unknown.length) {
      tried++;
      for (let t = 0; t < minLen.length; t++) if (used[t]! < minLen[t]!) return false;
      return matches();
    }
    if (tried >= MAX_ASSIGNMENTS || !stillPossible(slot)) return false;
    const seq = unknown[slot]!;
    const order = tails.map((_, t) => t).sort((a, b) => minLen[b]! - used[b]! - (minLen[a]! - used[a]!));
    for (const t of order) {
      const ops = tails[t]!.next[used[t]!];
      if (!ops || seq <= lastSeq[t]!) continue;
      if (clobbers(t, ops, seq)) continue;
      const prev = lastSeq[t]!;
      const placed: string[] = [];
      used[t]!++;
      lastSeq[t] = seq;
      chosen.push({ seq, ops });
      for (const op of ops) {
        const writer = lastWriter.get(op.key);
        if (writer?.kind === "tail" && writer.tab === t && writer.index === used[t]! - 1) {
          writerSeq.set(op.key, seq);
          placed.push(op.key);
        }
      }
      if (search(slot + 1)) return true;
      for (const key of placed) writerSeq.delete(key);
      chosen.pop();
      lastSeq[t] = prev;
      used[t]!--;
    }
    return false;
  };

  if (search(0)) return { ok: true, unknown: unknown.length, assignments: tried };
  const reason =
    tried >= MAX_ASSIGNMENTS
      ? `gave up after ${tried} assignments of ${unknown.length} unseen seqs`
      : `no assignment of ${unknown.length} unseen seqs to in-flight attempts gives the read state`;
  const detail: string[] = [`unseen seqs [${unknown.join(",")}]`];
  for (const key of touched) {
    if (fixed.get(key) !== observed.get(key)) detail.push(`${key}: read ${short(observed.get(key))}, acked log says ${short(fixed.get(key))}`);
  }
  return { ok: false, reason, detail: detail.slice(0, 12) };
}

function sameWriter(a: Writer, b: Writer): boolean {
  if (a.kind === "known" && b.kind === "known") return a.seq === b.seq;
  if (a.kind === "tail" && b.kind === "tail") return a.tab === b.tab && a.index === b.index;
  return false;
}

/** The one attempt whose put of `value` is its last effect on that key, if there is one. */
function findPut(
  value: string,
  known: readonly KillApplied[],
  tails: readonly KillTail[],
  window: number,
): Writer | "many" | undefined {
  let found: Writer | undefined;
  const consider = (writer: Writer): "many" | undefined => {
    if (found && !sameWriter(found, writer)) return "many";
    found = writer;
    return undefined;
  };
  for (const k of known) {
    for (const op of k.ops) {
      if (op.type !== "put" || op.value !== value) continue;
      const effect = net(k.ops, op.key);
      if (!effect.touched || effect.value !== value) continue;
      if (consider({ kind: "known", seq: k.seq }) === "many") return "many";
    }
  }
  for (let t = 0; t < tails.length; t++) {
    const next = tails[t]!.next;
    const limit = Math.min(next.length, window);
    for (let i = 0; i < limit; i++) {
      const ops = next[i]!;
      for (const op of ops) {
        if (op.type !== "put" || op.value !== value) continue;
        const effect = net(ops, op.key);
        if (!effect.touched || effect.value !== value) continue;
        if (consider({ kind: "tail", tab: t, index: i }) === "many") return "many";
      }
    }
  }
  return found;
}

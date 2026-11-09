import { compareBytes } from "../../src/bytes.js";
import { EngineHost, MemoryFs, createLocalIngestClient } from "../../src/index.js";
import { openHarnessDb } from "../../src/testing.js";
import type { Db } from "../../src/index.js";
import { scanFrames } from "../../src/log/frame.js";
import { checkDatabase, type DatabaseReport } from "./check-database.js";
import { describeOp, FaultFs, Faults, fsFiles, materializeFs, type DurableOp } from "./fault-fs.js";
import { Oracle, show, type OracleEntry, type OracleOp } from "./oracle.js";

/**
 * Crash states and the recovery check (docs/research/corruption-hardening-test-suite.md,
 * "The contract the tests check", crash strength).
 *
 * A crash state keeps some of the durable ops of the trace (`fault-fs.ts`):
 * OPFS publishes, touches and removes (manifests, runs, reclaim), and each
 * tab's log segment creates, writes and flushes. Two crash models, both
 * cutting the trace at a crash point `k`:
 * - process crash (a tab or the SharedWorker killed; the OS keeps
 *   everything that completed): every op before `k`. A log write resolves
 *   an append once it is in the file, so every acked write survives: the
 *   state is the fold of every record in the logs.
 * - power loss: a log keeps every write before its last flush before `k`,
 *   and any prefix of the writes after it (architecture/wal-opfs/04: a
 *   record is broadcast only once flushed). Chromium's `createWritable`
 *   close has no fsync, so the OPFS file ops keep any prefix of theirs
 *   before `k`, unordered with the logs. Acked writes may be lost, but the
 *   database must open and its state must be `fold(log[1..p])` for some
 *   `p`.
 *
 * After the reopen, recovery runs: a fresh host flushes, compacts and
 * reclaims, and the files must pass `checkDatabase` with no orphans. Then
 * one more write and ingest, which builds on the committed manifest
 * (design.md, "Recovery"), must read back.
 */

/** One database whose durable ops are traced: a `FaultFs` over MemoryFs for the tabs and the host. */
export class Traced {
  readonly faults = new Faults();
  readonly mem = new MemoryFs();
  readonly fs = new FaultFs(this.mem, this.faults);
  host = new EngineHost(() => this.fs);

  /** `maxWalBytes`: the segment size, and the stable bytes past which a tab asks for an ingest. */
  constructor(
    readonly name: string,
    readonly maxWalBytes = 1 << 30,
  ) {}

  /** Start from crash state `cut` of `ops`, untraced. */
  async load(ops: readonly DurableOp[], cut: Cut): Promise<void> {
    await materializeFs(ops, keeper(ops, cut), this.mem);
  }

  open(maxWalBytes = this.maxWalBytes): Promise<Db> {
    return openHarnessDb({
      name: this.name,
      fs: this.fs,
      ingest: createLocalIngestClient(this.host),
      ingestPolicy: { maxWalBytes },
    });
  }

  /** The trace replayed in full equals the files, so it missed no write. */
  async expectTraceComplete(): Promise<void> {
    const files = await fsFiles(await materializeFs(this.faults.ops));
    const real = await fsFiles(this.mem);
    const differ = [...new Set([...files.keys(), ...real.keys()])].filter((p) => {
      const a = files.get(p);
      const b = real.get(p);
      return !a || !b || compareBytes(a, b) !== 0;
    });
    if (differ.length > 0) throw new Error(`replayed files differ at ${differ.join(", ")}`);
  }

  async dispose(): Promise<void> {}
}

/** A step of a fixed workload. Values are unique, so reads map back to seqs. */
export type Step =
  | { readonly put: string; readonly value: string }
  | { readonly del: string }
  | { readonly batch: readonly ({ readonly put: string; readonly value: string } | { readonly del: string })[] }
  | { readonly ingest: true }
  | { readonly reopen: true };

const utf = (s: string) => new TextEncoder().encode(s);

/** Run `steps` on one handle of `t`. Returns the log of every acked write. */
export async function runSteps(t: Traced, steps: readonly Step[], log: Oracle): Promise<void> {
  let db = await t.open();
  try {
    for (const step of steps) {
      if ("put" in step) {
        await db.put(utf(step.put), utf(step.value));
        log.append([{ type: "put", key: utf(step.put), value: utf(step.value) }]);
      } else if ("del" in step) {
        await db.delete(utf(step.del));
        log.append([{ type: "del", key: utf(step.del) }]);
      } else if ("batch" in step) {
        const ops = step.batch.map((op) =>
          "put" in op ? { type: "put" as const, key: utf(op.put), value: utf(op.value) } : { type: "del" as const, key: utf(op.del) },
        );
        await db.batch((tx) => {
          for (const op of ops) {
            if (op.type === "put") tx.put(op.key, op.value);
            else tx.delete(op.key);
          }
        });
        log.append(ops);
      } else if ("ingest" in step) {
        await db.ingest();
      } else {
        await db.close();
        db = await t.open();
      }
    }
  } finally {
    await db.close();
  }
}

/**
 * A crash state: the ops before crash point `k`, of which only the first
 * `opfs` OPFS file ops, and per log segment (by path) only the first
 * `logs[path]` writes when given.
 */
export type Cut = { readonly k: number; readonly opfs: number; readonly logs?: Readonly<Record<string, number>> };
export type CrashModel = "process" | "power";

/** Each op's place among the OPFS file ops, or among its segment's writes. */
function places(ops: readonly DurableOp[]): Map<DurableOp, number> {
  const out = new Map<DurableOp, number>();
  let opfs = 0;
  const writes = new Map<string, number>();
  for (const op of ops) {
    if (op.store === "opfs") out.set(op, ++opfs);
    else if (op.kind === "write") {
      const n = (writes.get(op.path) ?? 0) + 1;
      writes.set(op.path, n);
      out.set(op, n);
    }
  }
  return out;
}

/** Whether crash state `cut` keeps an op. */
function keeper(ops: readonly DurableOp[], cut: Cut): (op: DurableOp) => boolean {
  const at = places(ops);
  return (op) => {
    if (op.i > cut.k) return false;
    if (op.store === "opfs") return at.get(op)! <= cut.opfs;
    if (op.kind !== "write" || !cut.logs) return true;
    return at.get(op)! <= (cut.logs[op.path] ?? Number.POSITIVE_INFINITY);
  };
}

/** The process crash after the first `k` ops: all of them. */
export function processCut(ops: readonly DurableOp[], k: number): Cut {
  return { k, opfs: ops.slice(0, k).filter((o) => o.store === "opfs").length };
}

/** What a power loss at `k` may keep: of the OPFS ops, up to `opfs`; of each log, between its flushed writes and all of them. */
function powerRange(ops: readonly DurableOp[], k: number) {
  let opfs = 0;
  const logs = new Map<string, { flushed: number; written: number }>();
  for (const op of ops.slice(0, k)) {
    if (op.store === "opfs") opfs++;
    else if (op.kind === "write" || op.kind === "flush") {
      const l = logs.get(op.path) ?? { flushed: 0, written: 0 };
      if (op.kind === "write") l.written++;
      else l.flushed = l.written;
      logs.set(op.path, l);
    }
  }
  return { opfs, logs };
}

/**
 * Power-loss states, distinct by the ops they keep: at every crash point
 * the extremes (no unflushed log write, or every one; no OPFS op, or every
 * one), then random ones drawn with `random` up to `max` in all.
 */
export function powerCuts(ops: readonly DurableOp[], max: number, random: () => number): Cut[] {
  const out: Cut[] = [];
  const seen = new Set<string>();
  const add = (cut: Cut) => {
    const keep = keeper(ops, cut);
    const id = ops.filter(keep).map((o) => o.i).join(",");
    if (seen.has(id)) return;
    seen.add(id);
    out.push(cut);
  };
  const pick = (lo: number, hi: number) => lo + Math.floor(random() * (hi - lo + 1));
  const cutAt = (k: number, opfs: (n: number) => number, log: (l: { flushed: number; written: number }) => number): Cut => {
    const range = powerRange(ops, k);
    const logs: Record<string, number> = {};
    for (const [path, l] of range.logs) logs[path] = log(l);
    return { k, opfs: opfs(range.opfs), logs };
  };
  for (let k = 0; k <= ops.length && out.length < max; k++) {
    for (const opfs of [(n: number) => n, () => 0]) {
      for (const log of [(l: { flushed: number }) => l.flushed, (l: { written: number }) => l.written]) add(cutAt(k, opfs, log));
    }
  }
  for (let tries = 0; out.length < max && tries < max * 20; tries++) {
    add(cutAt(pick(0, ops.length), (n) => pick(0, n), (l) => pick(l.flushed, l.written)));
  }
  return out.slice(0, max);
}

/** What the crash state kept, for a failure message. */
export function describeCut(ops: readonly DurableOp[], cut: Cut): string {
  const keep = keeper(ops, cut);
  const shown = ops.filter((o) => o.i <= cut.k || o.i === cut.k + 1);
  return `crash after op ${cut.k} of ${ops.length}, OPFS keeps ${cut.opfs}:\n` +
    shown.map((o) => `${o.i > cut.k ? "  ---- crash" : keep(o) ? "  kept" : "  LOST"} ${describeOp(o)}`).join("\n");
}

/**
 * The log the trace committed: every record the log writes hold, in the
 * one order (stamp, then tab). Throws unless each tab numbers its records
 * 1..n with no gap.
 */
export function committedLog(ops: readonly DurableOp[]): Oracle {
  const recs: { stamp: number; tab: string; n: number; ops: OracleOp[] }[] = [];
  for (const op of ops) {
    if (op.store !== "log" || op.kind !== "write") continue;
    const tab = op.path.split("/")[1]!;
    for (const r of scanFrames(op.bytes, undefined, 0).records) {
      recs.push({ stamp: r.stamp, tab, n: r.n, ops: r.ops.map((o) => (o.type === "put" ? { type: "put", key: o.key, value: o.value } : { type: "del", key: o.key })) });
    }
  }
  const byTab = new Map<string, number[]>();
  for (const r of recs) byTab.set(r.tab, [...(byTab.get(r.tab) ?? []), r.n]);
  for (const [tab, ns] of byTab) {
    if (ns.some((n, i) => n !== i + 1)) throw new Error(`tab ${tab} records are not numbered 1..n: ${ns.join(",")}`);
  }
  recs.sort((a, b) => a.stamp - b.stamp || (a.tab < b.tab ? -1 : a.tab > b.tab ? 1 : 0));
  const log = new Oracle();
  for (const r of recs) log.append(r.ops);
  return log;
}

let states = 0;

/**
 * Rebuild the crash state `cut` of `ops`, reopen it, and check it against
 * `oracle` (the log of the run that produced `ops`). Throws, with the cut
 * spelled out, when the database does not open or is not a log prefix.
 */
export async function checkCrashState(
  ops: readonly DurableOp[],
  oracle: Oracle,
  cut: Cut,
  model: CrashModel,
): Promise<void> {
  const name = `crash-${++states}`;
  try {
    await recover(name, ops, oracle, cut, model);
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    const error = new Error(`${model} crash state is not a log prefix or does not open: ${msg}\n${describeCut(ops, cut)}`);
    throw error;
  }
}

async function recover(name: string, ops: readonly DurableOp[], oracle: Oracle, cut: Cut, model: CrashModel): Promise<void> {
  const fs = await materializeFs(ops, keeper(ops, cut));
  const head = (await checkDatabase(fs, name)).head;
  const host = new EngineHost(() => fs);
  const open = () =>
    openHarnessDb({ name, fs, ingest: createLocalIngestClient(host), ingestPolicy: { maxWalBytes: 1 << 30 } });

  // 1. It opens, and reads one log prefix: exactly `head` after a process crash.
  let db: Db;
  try {
    db = await open();
  } catch (err) {
    throw new Error(`does not open: ${(err as Error).name}: ${(err as Error).message}`);
  }
  let prefixes: number[];
  try {
    prefixes = await readPrefixes(db, oracle, model === "process" ? head : 0, model === "process" ? head : oracle.head);
  } finally {
    await db.close();
  }

  // 2. Recovery: a fresh host flushes, compacts and reclaims what the crash left.
  await host.ingest(name, Number.POSITIVE_INFINITY, true);
  const report = await checkDatabase(fs, name);
  expectFiles(report, oracle, prefixes, "after recovery");

  // 3. Keep going: a write and an ingest on top of the recovered files.
  const key = new TextEncoder().encode(`crash/${name}`);
  const value = new TextEncoder().encode(`after ${name}`);
  db = await open();
  try {
    await db.put(key, value);
    await db.ingest();
    const got = await db.get(key);
    if (!got || show(got) !== show(value)) throw new Error(`write after recovery read back ${got && show(got)}`);
  } finally {
    await db.close();
  }
  // A host that swept before the write keeps runs the write retired until
  // it restarts (see "crash leftovers" in crash-enum.test.ts), so the last
  // sweep is a fresh host's.
  await new EngineHost(() => fs).ingest(name, 0, true);
  const after = await checkDatabase(fs, name);
  const withWrite = after.state.filter((e) => compareBytes(e.key, key) !== 0);
  expectFiles({ ...after, state: withWrite }, oracle, prefixes, "after a write on the recovered database");
}

/** The prefixes `p` in `[lo, hi]` that every read of the whole key space agrees with. */
async function readPrefixes(db: Db, oracle: Oracle, lo: number, hi: number): Promise<number[]> {
  const all: OracleEntry[] = [];
  for await (const e of db.range()) all.push({ key: new Uint8Array(e.key), value: new Uint8Array(e.value) });
  let set = oracle.rangeCandidates({}, all, lo).filter((p) => p <= hi);
  if (set.length === 0) {
    throw new Error(
      `range() = ${fmt(all)} is not fold(log[1..p]) for any p in [${lo}, ${hi}]; fold(log[1..${hi}]) = ${fmt(oracle.stateAt(hi))}`,
    );
  }
  for (const key of oracle.keys()) {
    const v = await db.get(key);
    const ok = new Set(oracle.getCandidates(key, v, lo));
    const next = set.filter((p) => ok.has(p));
    if (next.length === 0) {
      throw new Error(`get(${show(key)}) = ${v && show(v)} disagrees with range() at prefixes ${set.join(",")}`);
    }
    set = next;
  }
  return set;
}

function expectFiles(report: DatabaseReport, oracle: Oracle, prefixes: readonly number[], when: string): void {
  const problems = [...report.problems];
  if (report.orphans.length > 0) problems.push(`orphan runs ${report.orphans.join(", ")}`);
  if (report.staleManifests.length > 0) problems.push(`stale manifests ${report.staleManifests.join(", ")}`);
  if (problems.length > 0) throw new Error(`checkDatabase ${when}: ${problems.join("; ")}`);
  if (!prefixes.some((p) => sameEntries(oracle.stateAt(p), report.state))) {
    throw new Error(`files ${when} hold ${fmt(report.state)}, not fold(log[1..p]) for p in ${prefixes.join(",")}`);
  }
}

function sameEntries(a: readonly OracleEntry[], b: readonly OracleEntry[]): boolean {
  return (
    a.length === b.length &&
    a.every((e, i) => compareBytes(e.key, b[i]!.key) === 0 && compareBytes(e.value, b[i]!.value) === 0)
  );
}

function fmt(entries: readonly OracleEntry[]): string {
  return `[${entries.map((e) => `${show(e.key)}=${show(e.value)}`).join(", ")}]`;
}

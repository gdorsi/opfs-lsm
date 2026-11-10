import { compareBytes, keyToString } from "../../src/bytes.js";
import type { Db } from "../../src/index.js";
import { MemoryFs } from "../../src/index.js";
import { loadGeneration, manifestNumbers } from "../../src/store/generation.js";
import { Host, openHarnessDb } from "../../src/testing.js";
import { checkDatabase, type DatabaseReport } from "./check-database.js";
import { describeOp, FaultFs, Faults, fsFiles, materializeFs, traceSegments, type DurableOp } from "./fault-fs.js";
import { Oracle, show, type OracleEntry } from "./oracle.js";

/**
 * Crash states and the recovery check (docs/research/corruption-hardening-test-suite.md,
 * "The contract the tests check", crash strength).
 *
 * A crash state keeps the first `k` durable ops of a traced run: run files,
 * manifests, removes, and the log segments' writes. A process crash (a tab
 * or the SharedWorker killed) keeps every op that completed, so every write
 * acked before op `k` must survive. `drop` more models a power loss that
 * also lost the newest manifest publishes: the SharedWorker keeps the log
 * segments that the newest RECLAIM_LAG + 1 manifests need, so losing up to
 * RECLAIM_LAG of them must lose no acked write either. It may reorder them:
 * the recovery round re-ingests each log from the surviving manifest's
 * cursors, and two logs carry no order between them, so a page's write can
 * land before a write of a closed page that it had read (formal/ingest-plan
 * prints this as a finding). After lost manifests the check accepts the
 * surviving manifest's prefix and then each log's records whole, logs in
 * any order.
 *
 * After the reopen, recovery runs: the page ingests and compacts, a second
 * page's compaction pass reclaims, and the files must pass `checkDatabase`
 * with no orphans. Then one more write and ingest, which builds on the
 * newest manifest, must read back.
 */

/** A crash state: the first `k` ops of the trace, then the newest `drop` manifests lost. */
export type Cut = { readonly k: number; readonly drop: number };

/** An acked write: how many durable ops had completed at its ack, and which page's log took it. */
export type Ack = { readonly at: number; readonly log: number };

/**
 * One database whose durable ops are traced: a `FaultFs` over MemoryFs for
 * the tab and the host, and the tab's log segments through `traceSegments`.
 */
export class Traced {
  readonly faults = new Faults();
  readonly mem = new MemoryFs();
  readonly fs = new FaultFs(this.mem, this.faults);
  readonly segments = traceSegments(this.mem.segments, this.faults);
  readonly host = new Host(() => this.fs, { maxLatencyMs: 1e9 });
  /** Each acked write, in ack order. */
  readonly acks: Ack[] = [];

  constructor(readonly name: string) {}

  open(): Promise<Db> {
    return openHarnessDb({ name: this.name, fs: this.fs, segments: this.segments, host: this.host });
  }

  /** The trace replayed in full equals the files, so it missed no write. */
  async expectTraceComplete(): Promise<void> {
    const ops = this.faults.ops;
    const files = await fsFiles(await materializeFs(ops, ops.length));
    const real = await fsFiles(this.mem);
    const differ = [...new Set([...files.keys(), ...real.keys()])].filter((p) => {
      const a = files.get(p);
      const b = real.get(p);
      return !a || !b || compareBytes(a, b) !== 0;
    });
    if (differ.length > 0) throw new Error(`replayed files differ at ${differ.join(", ")}`);
  }
}

/** A step of a fixed workload. Values are unique, so reads map back to seqs. */
export type Step =
  | { readonly put: string; readonly value: string }
  | { readonly del: string }
  | { readonly batch: readonly ({ readonly put: string; readonly value: string } | { readonly del: string })[] }
  | { readonly ingest: true }
  | { readonly reopen: true };

const utf = (s: string) => new TextEncoder().encode(s);

/** Run `steps` on one handle of `t`, appending every acked write to `log`. */
export async function runSteps(t: Traced, steps: readonly Step[], log: Oracle): Promise<void> {
  let db = await t.open();
  let page = 0;
  const acked = (ops: Parameters<Oracle["append"]>[0]) => {
    log.append(ops);
    t.acks.push({ at: t.faults.ops.length, log: page });
  };
  try {
    for (const step of steps) {
      if ("put" in step) {
        await db.put(utf(step.put), utf(step.value));
        acked([{ type: "put", key: utf(step.put), value: utf(step.value) }]);
      } else if ("del" in step) {
        await db.delete(utf(step.del));
        acked([{ type: "del", key: utf(step.del) }]);
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
        acked(ops);
      } else if ("ingest" in step) {
        await db.ingest();
      } else {
        await db.close();
        db = await t.open();
        page++;
      }
    }
  } finally {
    await db.close();
  }
}

/** The files crash state `cut` leaves, and the `through` of the newest manifest it kept. */
async function crashState(ops: readonly DurableOp[], cut: Cut): Promise<{ fs: MemoryFs; through: number }> {
  const fs = await materializeFs(ops, cut.k);
  const manifests = (await manifestNumbers(fs)).sort((a, b) => b - a);
  for (const n of manifests.slice(0, cut.drop)) await fs.remove(`m/${String(n).padStart(16, "0")}.mft`);
  const kept = manifests[cut.drop];
  return { fs, through: kept === undefined ? 0 : ((await loadGeneration(fs, kept))?.through ?? 0) };
}

/** What the crash state kept, for a failure message. */
function describeCut(ops: readonly DurableOp[], cut: Cut): string {
  const kept = ops.map((o, i) => `${i < cut.k ? "  kept" : "  LOST"} ${describeOp(o)}`).join("\n");
  return `keeps ${cut.k}/${ops.length} ops, then loses the newest ${cut.drop} manifests:\n${kept}`;
}

let states = 0;

/**
 * Rebuild crash state `cut` of `ops`, reopen it, and check it against `log`
 * (the acked writes of the run that produced `ops`, in the order of
 * `acks`). Throws, with the cut spelled out, when the database does not
 * open or does not hold every write acked before the cut, in log order (or
 * a log order the lost manifests allow).
 */
export async function checkCrashState(ops: readonly DurableOp[], log: Oracle, acks: readonly Ack[], cut: Cut): Promise<void> {
  try {
    await recover(`crash-${++states}`, ops, log, acks, cut);
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    throw new Error(`crash state does not hold every acked write in an allowed order, or does not open: ${msg}\n${describeCut(ops, cut)}`);
  }
}

/** A state recovery may read: `order` names the seqs folded, for a failure message. */
type Candidate = { readonly order: string; readonly state: OracleEntry[] };

/**
 * Every state the crash state may recover to: each write acked before the
 * cut is in, and so are any later ones up to the run's head. With no lost
 * manifest that is a prefix of the log. After lost manifests it is the kept
 * manifest's prefix `log[1..through]`, then each log's later records whole,
 * in any order of the logs.
 */
function candidates(oracle: Oracle, acks: readonly Ack[], cut: Cut, through: number): Candidate[] {
  const acked = acks.filter((a) => a.at <= cut.k).length;
  const out: Candidate[] = [];
  for (let e = Math.max(acked, through); e <= oracle.head; e++) {
    out.push({ order: `log[1..${e}]`, state: oracle.stateAt(e) });
    if (cut.drop === 0) continue;
    const logs = new Map<number, number[]>();
    for (let seq = through + 1; seq <= e; seq++) {
      const log = acks[seq - 1]!.log;
      logs.set(log, [...(logs.get(log) ?? []), seq]);
    }
    for (const chunks of permutations([...logs.values()]).slice(1)) {
      out.push({
        order: `log[1..${through}] then ${chunks.map((c) => c.join(",")).join(" then ")}`,
        state: fold(oracle, oracle.stateAt(through), chunks.flat()),
      });
    }
  }
  return out;
}

/** Every order of `items`, the given one first. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}

/** `base` with the batches at `seqs` applied in that order. */
function fold(oracle: Oracle, base: readonly OracleEntry[], seqs: readonly number[]): OracleEntry[] {
  const state = new Map(base.map((e) => [keyToString(e.key), e]));
  for (const seq of seqs) {
    for (const op of oracle.opsAt(seq)) {
      if (op.type === "put") state.set(keyToString(op.key), { key: op.key, value: op.value });
      else state.delete(keyToString(op.key));
    }
  }
  return [...state.values()].sort((a, b) => compareBytes(a.key, b.key));
}

async function recover(name: string, ops: readonly DurableOp[], log: Oracle, acks: readonly Ack[], cut: Cut): Promise<void> {
  const { fs, through } = await crashState(ops, cut);
  const host = new Host(() => fs, { maxLatencyMs: 1e9 });
  const open = () => openHarnessDb({ name, fs, host });

  // 1. It opens, and reads one allowed state that holds every acked write.
  let db: Db;
  try {
    db = await open();
  } catch (err) {
    throw new Error(`does not open: ${(err as Error).name}: ${(err as Error).message}`);
  }
  let allowed: Candidate[];
  try {
    allowed = await readStates(db, log.keys(), candidates(log, acks, cut, through));
    // 2. Recovery: ingest and compact what the crash left; a second page's pass reclaims.
    await db.ingest();
  } finally {
    await db.close();
  }
  db = await open();
  await db.ingest();
  await db.close();
  expectFiles(await checkDatabase(fs), allowed, "after recovery");

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
  db = await open();
  await db.ingest();
  await db.close();
  const after = await checkDatabase(fs);
  const withoutWrite = after.state.filter((e) => compareBytes(e.key, key) !== 0);
  expectFiles({ ...after, state: withoutWrite }, allowed, "after a write on the recovered database");
}

/** The candidates that `range()` of the whole key space reads, with every `get` agreeing. */
async function readStates(db: Db, keys: readonly Uint8Array[], all: readonly Candidate[]): Promise<Candidate[]> {
  const read: OracleEntry[] = [];
  for await (const e of db.range()) read.push({ key: new Uint8Array(e.key), value: new Uint8Array(e.value) });
  const set = all.filter((c) => sameEntries(c.state, read));
  if (set.length === 0) {
    throw new Error(`range() = ${fmt(read)} is none of\n${all.map((c) => `  ${c.order} = ${fmt(c.state)}`).join("\n")}`);
  }
  for (const key of keys) {
    const v = await db.get(key);
    const want = read.find((e) => compareBytes(e.key, key) === 0)?.value;
    if ((v && show(v)) !== (want && show(want))) {
      throw new Error(`get(${show(key)}) = ${v && show(v)} disagrees with range() = ${want && show(want)}`);
    }
  }
  return set;
}

function expectFiles(report: DatabaseReport, allowed: readonly Candidate[], when: string): void {
  const problems = [...report.problems];
  if (report.orphans.length > 0) problems.push(`orphan runs ${report.orphans.join(", ")}`);
  if (report.staleManifests.length > 0) problems.push(`stale manifests ${report.staleManifests.join(", ")}`);
  if (report.pending > 0) problems.push(`${report.pending} records not ingested`);
  if (problems.length > 0) throw new Error(`checkDatabase ${when}: ${problems.join("; ")}`);
  if (!allowed.some((c) => sameEntries(c.state, report.state))) {
    throw new Error(`files ${when} hold ${fmt(report.state)}, not ${allowed.map((c) => c.order).join(" or ")}`);
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

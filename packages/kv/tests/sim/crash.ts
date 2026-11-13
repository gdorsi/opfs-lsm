import { compareBytes } from "../../src/bytes.js";
import { __resetMergeSlotForTests } from "../../src/host/merge-slot.js";
import { __restartEngineForTests } from "../../src/store/engine.js";
import {
  openHarnessDb,
  ingest,
  EngineHost,
  MemoryFs,
  createLocalIngestClient,
} from "../../src/testing.js";
import type { Db } from "../../src/index.js";
import { checkDatabase, decodeWalRow, deleteWal, type DatabaseReport } from "./check-database.js";
import { describeOp, FaultFs, Faults, fsFiles, materializeFs, type DurableOp } from "./fault-fs.js";
import { dumpWal, materializeWal, traceWal } from "./fault-wal.js";
import { applyOps, Oracle, show, type OracleEntry, type OracleOp } from "./oracle.js";

/**
 * Crash states and the recovery check (docs/research/corruption-hardening-test-suite.md,
 * "The contract the tests check", crash strength).
 *
 * A crash state keeps a prefix of each store's durable ops: `idb` commits
 * and `opfs` file ops. Two crash models:
 * - process crash (a tab or the SharedWorker killed; the OS keeps
 *   everything that completed): one cut `k` in the global order, so both
 *   stores keep exactly the ops before `k`. Every committed write must
 *   survive: the state is `fold(log[1..head])`, where `head` is the WAL
 *   head the crash state recorded, which is at least every acked seq.
 * - power loss: IndexedDB commits with relaxed durability, Chromium's OPFS
 *   close path has no fsync, and nothing orders the two stores (the note's
 *   "Browser durability facts"). Each store keeps a prefix of its own ops,
 *   independently. Acked writes may be lost, but the database must open and
 *   its state must be `fold(log[1..p])` for some `p`.
 *
 * After the reopen, recovery runs: a fresh host flushes, compacts and
 * reclaims, and the files must pass `checkDatabase` with no orphans. Then
 * one more write and ingest, which builds on the recorded manifest
 * (design.md, "Recovery"), must read back.
 */

/**
 * One database whose durable ops are traced: a `FaultFs` over MemoryFs for
 * the tab and the host, and the WAL registered with the IndexedDB seam
 * (`installFaultWal` must be installed).
 */
export class Traced {
  readonly faults = new Faults();
  readonly mem = new MemoryFs();
  readonly fs = new FaultFs(this.mem, this.faults);
  host: EngineHost;
  private unregister: () => void;

  /** `flushRunBytes` is the host's cap on op bytes per L0 run. */
  constructor(
    readonly name: string,
    flushRunBytes?: number,
  ) {
    this.host = new EngineHost(() => this.fs, flushRunBytes === undefined ? {} : { flushRunBytes });
    this.unregister = traceWal(name, this.faults);
  }

  /** Start from crash state `cut` of `ops`, untraced. */
  async load(ops: readonly DurableOp[], cut: Cut): Promise<void> {
    this.unregister();
    await materializeWal(this.name, ops, cut.idb);
    this.unregister = traceWal(this.name, this.faults);
    const files = await materializeFs(ops, cut.opfs);
    for (const path of files.publishedPaths()) {
      const w = await this.mem.create(path);
      await w.write((await files.read(path, 0, Number.POSITIVE_INFINITY))!);
      await w.finish();
    }
  }

  open(maxWalBytes = 1 << 30): Promise<Db> {
    return openHarnessDb({
      name: this.name,
      fs: this.fs,
      ingest: createLocalIngestClient(this.host),
      maxWalBytes,
    });
  }

  /** The trace replayed in full equals both stores, so it missed no write. */
  async expectTraceComplete(): Promise<void> {
    const ops = this.faults.ops;
    const replayed = `${this.name}-replay`;
    try {
      await materializeWal(replayed, ops, ops.length);
      const [want, got] = await Promise.all([dumpWal(this.name), dumpWal(replayed)]);
      if (JSON.stringify(serialize(want)) !== JSON.stringify(serialize(got))) {
        throw new Error(`replayed IndexedDB differs:\n${JSON.stringify(serialize(want))}\n${JSON.stringify(serialize(got))}`);
      }
    } finally {
      await deleteWal(replayed);
    }
    const files = await fsFiles(await materializeFs(ops, ops.length));
    const real = await fsFiles(this.mem);
    const differ = [...new Set([...files.keys(), ...real.keys()])].filter((p) => {
      const a = files.get(p);
      const b = real.get(p);
      return !a || !b || compareBytes(a, b) !== 0;
    });
    if (differ.length > 0) throw new Error(`replayed OPFS differs at ${differ.join(", ")}`);
  }

  /** A host frozen mid-merge leaves a session open and a turn taken in this context, as a dead process would not. */
  async dispose(): Promise<void> {
    this.unregister();
    await deleteWal(this.name);
    __resetMergeSlotForTests();
    __restartEngineForTests();
  }
}

function serialize(dump: { wal: [IDBValidKey, unknown][]; meta: [IDBValidKey, unknown][] }): unknown {
  const bytes = (v: unknown) => (v instanceof ArrayBuffer ? [...new Uint8Array(v)] : v);
  return { wal: dump.wal.map(([k, v]) => [k, bytes(v)]), meta: dump.meta.map(([k, v]) => [k, bytes(v)]) };
}

/** A step of a fixed workload. Values are unique, so reads map back to seqs. */
export type Step =
  | { readonly put: string; readonly value: string }
  | { readonly del: string }
  | { readonly batch: readonly ({ readonly put: string; readonly value: string } | { readonly del: string })[] }
  /** A range delete of every row in [deleteRange, end) written before it. */
  | { readonly deleteRange: string; readonly end?: string }
  | { readonly ingest: true }
  | { readonly destroy: true }
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
      } else if ("deleteRange" in step) {
        const op = { type: "deleteRange" as const, start: utf(step.deleteRange), ...(step.end ? { endExclusive: utf(step.end) } : {}) };
        await db.batch((tx) => applyOps(tx, [op]));
        log.append([op]);
      } else if ("ingest" in step) {
        await ingest(db);
      } else if ("destroy" in step) {
        // Destroy takes one seq: a delete of every key written before it.
        await db.dangerousDestroy();
        log.append(log.keys().map((key) => ({ type: "del" as const, key })));
      } else {
        await db.close();
        db = await t.open();
      }
    }
  } finally {
    await db.close();
  }
}

export type Cut = { readonly idb: number; readonly opfs: number };
export type CrashModel = "process" | "power";

/** The cut after the first `k` ops in global order. */
export function processCut(ops: readonly DurableOp[], k: number): Cut {
  let idb = 0;
  let opfs = 0;
  for (const op of ops.slice(0, k)) {
    if (op.store === "idb") idb++;
    else opfs++;
  }
  return { idb, opfs };
}

/**
 * Every `(idb, opfs)` prefix pair a power loss can leave, or `max` of them
 * drawn with `random` when there are more. A strict IndexedDB commit is on
 * disk before the next op starts, so a pair that keeps an OPFS op after it
 * keeps it too.
 */
export function powerCuts(ops: readonly DurableOp[], max: number, random: () => number): Cut[] {
  const idbOps = ops.filter((o) => o.store === "idb");
  const opfsOps = ops.filter((o) => o.store === "opfs");
  const nIdb = idbOps.length;
  const nOpfs = opfsOps.length;
  /** The fewest IndexedDB commits a pair keeping `opfs` OPFS ops keeps. */
  const minIdb = (opfs: number): number => {
    const last = opfs === 0 ? -1 : opfsOps[opfs - 1]!.i;
    let need = 0;
    for (const [k, op] of idbOps.entries()) if (op.strict && op.i < last) need = k + 1;
    return need;
  };
  const possible: Cut[] = [];
  for (let opfs = 0; opfs <= nOpfs; opfs++) {
    for (let idb = minIdb(opfs); idb <= nIdb; idb++) possible.push({ idb, opfs });
  }
  if (possible.length <= max) return possible;
  const seen = new Set<number>();
  const out: Cut[] = [];
  while (out.length < max) {
    const i = Math.floor(random() * possible.length);
    if (seen.has(i)) continue;
    seen.add(i);
    out.push(possible[i]!);
  }
  return out;
}

/** What each store kept, for a failure message. */
export function describeCut(ops: readonly DurableOp[], cut: Cut): string {
  const idb = ops.filter((o) => o.store === "idb");
  const opfs = ops.filter((o) => o.store === "opfs");
  const kept = (list: DurableOp[], n: number) =>
    list.map((o, i) => `${i < n ? "  kept" : "  LOST"} ${describeOp(o)}`).join("\n");
  return `IndexedDB keeps ${cut.idb}/${idb.length} commits, OPFS keeps ${cut.opfs}/${opfs.length} ops:\n` +
    `${kept(idb, cut.idb)}\n${kept(opfs, cut.opfs)}`;
}

/**
 * The log the trace committed: every WAL row an IndexedDB commit added, by
 * seq. Throws unless the seqs are 1..n with no gap. A row deleted by its
 * own key is not a record: recovery and destroy add and delete one to move
 * the key generator.
 */
export function committedLog(ops: readonly DurableOp[]): Oracle {
  const rows = new Map<number, OracleOp[]>();
  for (const op of ops) {
    if (op.store !== "idb") continue;
    for (const m of op.muts) {
      if (m.store !== "wal") continue;
      if (m.kind === "delete") {
        if (typeof m.key === "number") rows.delete(m.key);
        continue;
      }
      rows.set(m.key as number, decodeWalRow(m.value).map((o): OracleOp => {
        if ("start" in o) return { type: "deleteRange", ...o };
        return o.value === undefined ? { type: "del", key: o.key } : { type: "put", key: o.key, value: o.value };
      }));
    }
  }
  const log = new Oracle();
  const seqs = [...rows.keys()].sort((a, b) => a - b);
  seqs.forEach((seq, i) => {
    if (seq !== i + 1) throw new Error(`committed seqs are not gapless: ${seqs.join(",")}`);
    log.append(rows.get(seq)!);
  });
  return log;
}

/** The first `count` IndexedDB commits. `count` is a count of those commits, as in `materializeWal`. */
function idbCommits(ops: readonly DurableOp[], count: number): Extract<DurableOp, { store: "idb" }>[] {
  return ops.filter((op): op is Extract<DurableOp, { store: "idb" }> => op.store === "idb").slice(0, count);
}

/** The `meta` rows the first `count` IndexedDB commits left. */
function metaAt(ops: readonly DurableOp[], count: number): Map<string, number> {
  const meta = new Map<string, number>();
  for (const op of idbCommits(ops, count)) {
    for (const m of op.muts) if (m.store === "meta" && m.kind === "put") meta.set(String(m.key), m.value as number);
  }
  return meta;
}

/** The head after the first `count` IndexedDB commits: the highest seq appended, or `ingestedThrough` when that is higher. */
function headAt(ops: readonly DurableOp[], count: number): number {
  let head = metaAt(ops, count).get("ingestedThrough") ?? 0;
  for (const op of idbCommits(ops, count)) {
    for (const m of op.muts) if (m.store === "wal" && m.kind === "put") head = Math.max(head, m.key as number);
  }
  return head;
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
  } finally {
    await deleteWal(name);
  }
}

async function recover(name: string, ops: readonly DurableOp[], oracle: Oracle, cut: Cut, model: CrashModel): Promise<void> {
  await materializeWal(name, ops, cut.idb);
  const fs = await materializeFs(ops, cut.opfs);
  const head = headAt(ops, cut.idb);
  const host = new EngineHost(() => fs);
  const open = () =>
    openHarnessDb({ name, fs, ingest: createLocalIngestClient(host), maxWalBytes: 1 << 30 });

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
  await host.ingest(name, true);
  const report = await checkDatabase(fs, name);
  expectFiles(report, oracle, prefixes, "after recovery");

  // 3. Keep going: a write and an ingest on top of the recovered files.
  const key = new TextEncoder().encode(`crash/${name}`);
  const value = new TextEncoder().encode(`after ${name}`);
  db = await open();
  try {
    await db.put(key, value);
    await ingest(db);
    const got = await db.get(key);
    if (!got || show(got) !== show(value)) throw new Error(`write after recovery read back ${got && show(got)}`);
  } finally {
    await db.close();
  }
  await host.compact(name);
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

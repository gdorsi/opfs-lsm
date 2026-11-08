/**
 * Exhaustive check: every power-loss crash state recovers to a log prefix,
 * including a second power loss during or after the first recovery.
 *
 * Run: pnpm --filter @opfs-lsm/kv formal:power-loss
 *
 * Every workload of up to MAX_CMDS appends, ingests and compactions runs on
 * the model in model.ts. For every pair (IndexedDB prefix, OPFS prefix) of
 * its durable ops: open (`reconcile`), read, recover (sweep, ingest,
 * compact), keep writing, and crash again at every pair of the recovery's
 * ops. Properties:
 * - PowerPrefix: every read is the set of writes of one log prefix, and the
 *   database always opens;
 * - ProcessAll: a cut that is a prefix of the global order (a process
 *   crash) reads every acked write;
 * - RecoveryStable: recovery's ingest and compaction change no read, leave
 *   a healthy database (`checkDatabase`), and later writes read back.
 * Broken variants (build on the newest manifest, no head raise, no
 * fallback, no newer-manifest adoption) must each fail, so the model is
 * strong enough to see the bugs the crash suite found.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloneIdb, cloneOpfs, emptyIdb, emptyOpfs, replay, Stuck, Sys, type Idb, type Op, type Opfs, type Variant } from "./model.js";

const MAX_CMDS = Number(process.env.FORMAL_POWER_CMDS ?? 6);
/** Power losses in a row: the first, then one during or after each recovery. */
const CRASHES = Number(process.env.FORMAL_POWER_CRASHES ?? 2);
type Cmd = "append" | "ingest" | "compact";
const CMDS: Cmd[] = ["append", "ingest", "compact"];
/** Writes after the first recovery, before the second crash. */
const AFTER: Cmd[] = ["append", "ingest", "append", "compact"];

class Violation extends Error {}

function* workloads(max: number): Generator<Cmd[]> {
  const rec = function* (prefix: Cmd[]): Generator<Cmd[]> {
    if (prefix.length > 0) yield prefix;
    if (prefix.length === max) return;
    for (const c of CMDS) yield* rec([...prefix, c]);
  };
  yield* rec([]);
}

function run(sys: Sys, cmd: Cmd): void {
  if (cmd === "append") sys.append();
  else if (cmd === "ingest") sys.ingest();
  else sys.compact();
}

/** The length of the log prefix whose writes are `got`, or a violation. */
function prefixOf(got: Set<number>, log: readonly number[], what: string): number {
  const k = got.size;
  const want = new Set(log.slice(0, k));
  if (k > log.length || [...got].some((id) => !want.has(id))) {
    throw new Violation(`${what}: read {${[...got].sort((a, b) => a - b).join(",")}}, not a prefix of log [${log.join(",")}]`);
  }
  return k;
}

function read(sys: Sys, what: string): Set<number> {
  try {
    return sys.read();
  } catch (err) {
    if (err instanceof Stuck) throw new Violation(`${what}: does not open (${err.message})`);
    throw err;
  }
}

/** True when the cut keeps exactly the first k ops in global order for some k. */
function isProcessCut(ops: readonly Op[], idb: number, opfs: number): boolean {
  let i = 0;
  let o = 0;
  for (const op of ops) {
    if (i === idb && o === opfs) return true;
    if (op.store === "idb") i++;
    else o++;
  }
  return i === idb && o === opfs;
}

/** Acked write ids in the first `idb` IndexedDB ops. */
function committed(ops: readonly Op[], idb: number): number[] {
  const out: number[] = [];
  let i = 0;
  for (const op of ops) {
    if (op.store !== "idb") continue;
    if (i++ >= idb) break;
    if (op.label.startsWith("append")) for (const [, id] of op.put ?? []) out.push(id);
  }
  return out;
}

let states = 0;

/**
 * Recover the crash state `st` of a run whose log was `log`, check it, and
 * when `depth` allows, crash again at every pair of the recovery's ops.
 */
function recover(st: { idb: Idb; opfs: Opfs }, log: readonly number[], mustHold: number | undefined, depth: number, v: Variant, where: string): void {
  states++;
  const sys = new Sys(cloneIdb(st.idb), cloneOpfs(st.opfs), v, 1000 * depth + 1);
  const opened = read(sys, `${where}: open`);
  const k = prefixOf(opened, log, `${where}: open`);
  if (mustHold !== undefined && k !== mustHold) {
    throw new Violation(`${where}: a process crash lost acked writes: read ${k} of ${mustHold}`);
  }
  const kept = log.slice(0, k);
  for (const step of ["sweep", "ingest", "compact"] as const) {
    sys[step]();
    const sick = sys.problem();
    if (sick) throw new Violation(`${where}: unhealthy after recovery's ${step}: ${sick}`);
  }
  if (prefixOf(read(sys, `${where}: recovered`), kept, `${where}: recovery changed the read`) !== k) {
    throw new Violation(`${where}: recovery changed the read`);
  }
  for (const cmd of AFTER) run(sys, cmd);
  const full = [...kept, ...sys.acked];
  if (prefixOf(read(sys, `${where}: after writes`), full, `${where}: after writes`) !== full.length) {
    throw new Violation(`${where}: writes after recovery did not read back`);
  }
  if (depth >= CRASHES) return;
  const base = { idb: st.idb, opfs: st.opfs };
  const nI = sys.ops.filter((o) => o.store === "idb").length;
  const nO = sys.ops.length - nI;
  for (let i = 0; i <= nI; i++) {
    for (let o = 0; o <= nO; o++) {
      const cut = replay(base, sys.ops, i, o);
      const proc = isProcessCut(sys.ops, i, o) ? kept.length + committed(sys.ops, i).length : undefined;
      recover(cut, full, proc, depth + 1, v, `${where} → recovery crash (idb ${i}/${nI}, opfs ${o}/${nO})`);
    }
  }
}

function checkWorkload(cmds: readonly Cmd[], v: Variant, depth: number): void {
  const sys = new Sys(emptyIdb(), emptyOpfs(), v, 1);
  sys.reconcile();
  for (const c of cmds) run(sys, c);
  const nI = sys.ops.filter((o) => o.store === "idb").length;
  const nO = sys.ops.length - nI;
  const empty = { idb: emptyIdb(), opfs: emptyOpfs() };
  for (let i = 0; i <= nI; i++) {
    for (let o = 0; o <= nO; o++) {
      const cut = replay(empty, sys.ops, i, o);
      const proc = isProcessCut(sys.ops, i, o) ? committed(sys.ops, i).length : undefined;
      const kept = (list: Op[], n: number) => list.slice(0, n).map((x) => x.label).join(", ");
      const where = `[${cmds.join(" ")}] crash: IndexedDB keeps [${kept(sys.ops.filter((x) => x.store === "idb"), i)}], OPFS keeps [${kept(sys.ops.filter((x) => x.store === "opfs"), o)}]`;
      recover(cut, sys.acked, proc, depth, v, where);
    }
  }
}

function explore(v: Variant, maxCmds: number, depth: number): string | undefined {
  for (const cmds of workloads(maxCmds)) {
    try {
      checkWorkload(cmds, v, depth);
    } catch (err) {
      if (err instanceof Violation) return err.message;
      throw err;
    }
  }
  return undefined;
}

/** The product still makes the decisions the model encodes. */
function sourceSync(): string[] {
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");
  const read = (f: string) => fs.readFileSync(path.join(src, f), "utf8");
  const out: string[] = [];
  const need = (file: string, re: RegExp, what: string) => {
    if (!re.test(read(file))) out.push(`${file}: ${what}`);
  };
  need("host/ingest.ts", /reconcile\(wal, fs, trust\)[\s\S]*loadGeneration\(fs, base\.generation\)[\s\S]*base\.top \+ 1[\s\S]*publishL0[\s\S]*publishGeneration[\s\S]*through: last[\s\S]*advanceIngested/, "ingest builds on the recorded generation and numbers past the top manifest");
  need("host/compact.ts", /reconcile\(wal, fs, trust\)[\s\S]*loadGeneration\(fs, base\.generation\)[\s\S]*base\.top \+ 1[\s\S]*through: meta\.through[\s\S]*raiseGeneration/, "install builds on the recorded generation");
  need("idb/wal.ts", /async advanceIngested[\s\S]*delete\(IDBKeyRange\.upperBound\(existing\)\)/, "advanceIngested keeps the records it folds until the next ingest");
  need("idb/wal.ts", /Math\.max\(head, through, floor\)/, "adopt raises head past every seq a manifest names");
  need("idb/wal.ts", /meta\.put\(Math\.max\(knownTop, top, generation\), META_TOP\)/, "adopt keeps the highest manifest number seen");
  need("recover.ts", /Math\.max\(numbers\[0\] \?\? 0, meta\.top, meta\.generation \?\? 0\)/, "new manifests number past every number in use");
  need("recover.ts", /m\.through > meta\.head && \(await isIntact\(fs, m\)\)/, "reconcile adopts an intact manifest past the head first");
  need("host/engine-host.ts", /reconcile\(wal, fs, this\.trust\(dbName\)\)[\s\S]*liveRuns\(fs, generation\)/, "reclaim sweeps against the reconciled generation's runs");
  need("db.ts", /await reconcile\(wal, fs, TRUST_RECORDED\);[\s\S]*await db\.sync\(\)/, "openDb reconciles before the first sync");
  need("db.ts", /if \(missing === undefined\) return;\s*await this\.repair\(\);/, "sync repairs when the recorded generation does not load");
  return out;
}

function main(): void {
  console.log(`bound: workloads of up to ${MAX_CMDS} appends/ingests/compactions, every (IndexedDB, OPFS) prefix pair,`);
  console.log(`       then recovery + [${AFTER.join(", ")}] and every pair of the next crash, ${CRASHES} crashes deep`);
  console.log("property: PowerPrefix, ProcessAll, RecoveryStable");

  const drift = sourceSync();
  if (drift.length > 0) {
    console.error("\nFAIL source sync: the model no longer matches the product");
    for (const d of drift) console.error(`  ${d}`);
    process.exit(1);
  }

  const broken: [string, Variant][] = [
    ["ingest builds on the newest manifest file", { buildOnNewest: true }],
    ["adopting a manifest leaves head where it was", { noHeadRaise: true }],
    ["no fallback when the recorded manifest is gone", { noFallback: true }],
    ["a newer manifest past the head is never adopted", { noNewerAdopt: true }],
    ["a manifest number is reused after recovery records an older one", { reuseNumbers: true }],
  ];
  for (const [name, v] of broken) {
    const found = explore(v, MAX_CMDS, 1);
    if (!found) {
      console.error(`\nFAIL model too weak: the broken variant "${name}" passes`);
      process.exit(1);
    }
    console.log(`  broken variant caught: ${name}`);
  }

  states = 0;
  const started = performance.now();
  const violation = explore({}, MAX_CMDS, 1);
  if (violation) {
    console.error(`\nFAIL PowerPrefix after ${states} crash states`);
    console.error(violation);
    process.exit(1);
  }
  console.log(`\nPASS PowerPrefix — ${states} crash states (${CRASHES} power losses deep) in ${Math.round(performance.now() - started)} ms`);
}

main();

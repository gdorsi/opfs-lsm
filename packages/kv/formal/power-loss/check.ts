/**
 * Exhaustive check: every power-loss crash state recovers to a log prefix,
 * including a second power loss during or after the first recovery.
 *
 * Run: pnpm --filter @opfs-lsm/kv formal:power-loss
 *
 * Every workload of up to MAX_CMDS appends, ingests (of every waiting
 * record, or of the oldest one: a chunk of a flush), compactions and
 * destroys runs on the model in model.ts. For every pair (IndexedDB prefix, OPFS prefix) of
 * its durable ops: open (`reconcile`), read, recover (sweep, ingest,
 * compact), keep writing, and crash again at every pair of the recovery's
 * ops. Properties:
 * - PowerPrefix: every read is the state after one log prefix (the writes
 *   since its last destroy), and the database always opens;
 * - ProcessAll: a cut that is a prefix of the global order (a process
 *   crash) reads every acked write;
 * - RecoveryStable: recovery's ingest and compaction change no read, leave
 *   a healthy database (`checkDatabase`), and later writes read back.
 * Every workload runs twice: once with reclaim, and once with a tab holding
 * the reclaim lock throughout, so the host removes no manifest or run.
 * - DestroyHolds: a crash that keeps an OPFS op after a destroy's commit
 *   reads the state after that destroy or later. The commit is strict, so
 *   no power loss keeps such an op without it (`possibleCut`).
 * Broken variants (build on the newest manifest, no head raise, an adopt or
 * a destroy that moves the head and not the key generator, no fallback, no
 * newer-manifest adoption, destroy files before its commit, or a destroy
 * commit at the default durability) must each fail, so the model is strong
 * enough to see the bugs the crash suite found.
 *
 * CorruptRefuse: after every workload, a run of the recorded manifest is
 * removed (corruption, which no power loss produces). Unless an intact
 * manifest holds every ingested seq, open must refuse, and open, sweep,
 * ingest and compaction must write nothing; with one, the read must still
 * hold every acked write. The rule from before the fix (`lossyRecovery`) must
 * fail this check.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloneIdb, cloneOpfs, DESTROYED, emptyIdb, emptyOpfs, possibleCut, Refused, replay, Stuck, Sys, type Idb, type Op, type Opfs, type Variant } from "./model.js";

const MAX_CMDS = Number(process.env.FORMAL_POWER_CMDS ?? 6);
/** Power losses in a row: the first, then one during or after each recovery. */
const CRASHES = Number(process.env.FORMAL_POWER_CRASHES ?? 2);
type Cmd = "append" | "update" | "ingest" | "ingestOne" | "compact" | "destroy";
const CMDS: Cmd[] = ["append", "ingest", "ingestOne", "compact", "destroy"];
/** Writes after the first recovery, before the second crash. */
const AFTER: Cmd[] = ["append", "ingest", "update", "compact"];

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
  else if (cmd === "update") sys.appendAfter();
  else if (cmd === "ingest") sys.ingest();
  else if (cmd === "ingestOne") sys.ingest(true);
  else if (cmd === "destroy") sys.destroy();
  else sys.compact();
}

/** The writes `log[0..k)` leaves: those since its last destroy. */
function stateAt(log: readonly number[], k: number): Set<number> {
  const prefix = log.slice(0, k);
  return new Set(prefix.slice(prefix.lastIndexOf(DESTROYED) + 1));
}

function same(a: Set<number>, b: Set<number>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

/** The longest log prefix whose state is `got`, or a violation. */
function prefixOf(got: Set<number>, log: readonly number[], what: string): number {
  for (let k = log.length; k >= 0; k--) if (same(stateAt(log, k), got)) return k;
  throw new Violation(`${what}: read {${[...got].sort((a, b) => a - b).join(",")}}, not the state after a prefix of log [${log.join(",")}]`);
}

function read(sys: Sys, what: string): Set<number> {
  try {
    return sys.read();
  } catch (err) {
    if (err instanceof Stuck) throw new Violation(`${what}: does not open (${err.message})`);
    if (err instanceof Refused) throw new Violation(`${what}: refused a state a power loss leaves (${err.message})`);
    throw err;
  }
}

/** A recovery step on a power-loss state: a refusal is a violation. */
function step(sys: Sys, name: "sweep" | "ingest" | "compact", what: string): void {
  try {
    sys[name]();
  } catch (err) {
    if (err instanceof Refused) throw new Violation(`${what}: ${name} refused a state a power loss leaves (${err.message})`);
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
    if (op.label === "destroy") out.push(DESTROYED);
  }
  return out;
}

/**
 * DestroyHolds: the log entries a crash that keeps the first `opfs` OPFS
 * ops must read past. A destroy whose commit came before a kept OPFS op
 * stays done, so the read is the state after it or later.
 */
function destroyedBefore(ops: readonly Op[], opfs: number): number {
  let o = 0;
  let entries = 0;
  let destroyed = 0;
  let through = 0;
  for (const op of ops) {
    if (op.store === "opfs") {
      if (o++ >= opfs) break;
      through = destroyed;
      continue;
    }
    if (op.label.startsWith("append")) entries += op.put?.length ?? 0;
    if (op.label === "destroy") destroyed = ++entries;
  }
  return through;
}

let states = 0;

/**
 * Recover the crash state `st` of a run whose log was `log`, check it, and
 * when `depth` allows, crash again at every pair of the recovery's ops.
 */
function recover(st: { idb: Idb; opfs: Opfs }, log: readonly number[], mustHold: number | undefined, depth: number, v: Variant, where: string, destroyedThrough = 0): void {
  states++;
  const sys = new Sys(cloneIdb(st.idb), cloneOpfs(st.opfs), v, 1000 * depth + 1);
  const opened = read(sys, `${where}: open`);
  const k = prefixOf(opened, log, `${where}: open`);
  if (k < destroyedThrough) {
    throw new Violation(`${where}: a destroy undone after its removes began: read the state after ${k} of ${destroyedThrough} log entries`);
  }
  if (mustHold !== undefined && !same(opened, stateAt(log, mustHold))) {
    throw new Violation(`${where}: a process crash lost acked writes: read the state after ${k} of ${mustHold}`);
  }
  const kept = log.slice(0, k);
  for (const name of ["sweep", "ingest", "compact"] as const) {
    step(sys, name, where);
    const sick = sys.problem();
    if (sick) throw new Violation(`${where}: unhealthy after recovery's ${name}: ${sick}`);
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
      if (!possibleCut(sys.ops, i, o)) continue;
      const cut = replay(base, sys.ops, i, o);
      const proc = isProcessCut(sys.ops, i, o) ? kept.length + committed(sys.ops, i).length : undefined;
      recover(cut, full, proc, depth + 1, v, `${where} → recovery crash (idb ${i}/${nI}, opfs ${o}/${nO})`, destroyedThrough);
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
      if (!possibleCut(sys.ops, i, o)) continue;
      const cut = replay(empty, sys.ops, i, o);
      const proc = isProcessCut(sys.ops, i, o) ? committed(sys.ops, i).length : undefined;
      const kept = (list: Op[], n: number) => list.slice(0, n).map((x) => x.label).join(", ");
      const where = `[${cmds.join(" ")}] crash: IndexedDB keeps [${kept(sys.ops.filter((x) => x.store === "idb"), i)}], OPFS keeps [${kept(sys.ops.filter((x) => x.store === "opfs"), o)}]`;
      recover(cut, sys.acked, proc, depth, v, where, destroyedBefore(sys.ops, o));
    }
  }
}

function explore(v: Variant, maxCmds: number, depth: number): string | undefined {
  for (const cmds of workloads(maxCmds)) {
    try {
      checkWorkload(cmds, v, depth);
    } catch (err) {
      if (err instanceof Violation) return err.message;
      // A refusal anywhere in a power-loss run: recovery called it corruption.
      if (err instanceof Refused) return `[${cmds.join(" ")}]: refused a state a power loss leaves (${err.message})`;
      throw err;
    }
  }
  return undefined;
}

let refusals = 0;
let standIns = 0;

/**
 * CorruptRefuse on one workload: remove each run of the recorded manifest
 * in turn. Returns a violation, or undefined.
 */
function checkCorruptRun(cmds: readonly Cmd[], v: Variant): string | undefined {
  const live = new Sys(emptyIdb(), emptyOpfs(), v, 1);
  live.reconcile();
  for (const c of cmds) run(live, c);
  const gen = live.idb.generation ?? 0;
  const runs = gen === 0 ? [] : live.opfs.manifests.get(gen)!.runs;
  for (const path of runs) {
    const where = `[${cmds.join(" ")}] then run ${path} of manifest ${gen} removed`;
    const opfs = cloneOpfs(live.opfs);
    opfs.runs.delete(path);
    const { ingested } = live.idb;
    const standIn = [...opfs.manifests.values()].some((m) => m.through >= ingested && m.runs.every((p) => opfs.runs.has(p)));
    if (standIn) {
      const sys = new Sys(cloneIdb(live.idb), opfs, v, 500);
      let got: Set<number>;
      try {
        got = sys.read();
      } catch (err) {
        if (err instanceof Refused || err instanceof Stuck) return `${where}: refused, though a manifest holds every ingested seq`;
        throw err;
      }
      if (!same(got, stateAt(live.acked, live.acked.length))) return `${where}: the stand-in lost acked writes`;
      standIns++;
      continue;
    }
    for (const name of ["read", "sweep", "ingest", "compact"] as const) {
      const sys = new Sys(cloneIdb(live.idb), cloneOpfs(opfs), v, 500);
      let refused = false;
      try {
        sys[name]();
      } catch (err) {
        if (!(err instanceof Refused)) throw err;
        refused = true;
      }
      if (sys.ops.length > 0) return `${where}: ${name} wrote ${sys.ops.map((o) => o.label).join(", ")}`;
      // A sweep skipped while a tab holds the reclaim lock writes nothing either.
      if (!refused && name === "read") return `${where}: open did not refuse`;
      if (refused) refusals++;
    }
  }
  return undefined;
}

function exploreCorrupt(v: Variant, maxCmds: number): string | undefined {
  for (const cmds of workloads(maxCmds)) {
    const found = checkCorruptRun(cmds, v) ?? checkCorruptRun(cmds, { ...v, held: true });
    if (found) return found;
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
  need("host/ingest.ts", /reconcile\(wal, fs, trusted\)[\s\S]*loadGeneration\(fs, base\.generation\)[\s\S]*base\.top \+ 1[\s\S]*publishL0[\s\S]*publishGeneration[\s\S]*through: last[\s\S]*advanceIngested/, "ingest builds on the recorded generation and numbers past the top manifest");
  need("host/compact.ts", /reconcile\(wal, fs, trusted\)[\s\S]*loadGeneration\(fs, base\.generation\)[\s\S]*base\.top \+ 1[\s\S]*through: meta\.through[\s\S]*raiseGeneration/, "install builds on the recorded generation");
  need("idb/wal.ts", /async function advanceIngested[\s\S]*delete\(IDBKeyRange\.upperBound\(existing\)\)/, "advanceIngested keeps the records it folds until the next ingest");
  need("idb/wal.ts", /Math\.max\(head, through, floor\)/, "adopt raises head past every seq a manifest names");
  need("idb/wal.ts", /function headOf\(last: number, ingestedThrough: number\): number \{\s*return Math\.max\(last, ingestedThrough\);/, "the head is the last WAL key, or ingestedThrough when no record is past it");
  need("idb/wal.ts", /nextIngested = nextHead;\s*wal\.delete\(IDBKeyRange\.upperBound\(head\)\);/, "an adopt that drops the records sets ingestedThrough to the new head, which is what holds it");
  need("idb/wal.ts", /if \(nextHead > head\) passKeyGenerator\(wal, nextHead\);/, "adopt moves the key generator with the head, so no append takes a seq at or below it");
  need("idb/wal.ts", /group\.tx\.objectStore\(WAL_STORE\)\.add\(entry\.record\)/, "an append takes the seq the key generator hands out");
  need("idb/wal.ts", /const seq = tail\.head \+ 1;\s*const record = encodeOps\(decision\.ops\);\s*tx\.objectStore\(WAL_STORE\)\.add\(record, seq\);/, "update appends at the explicit key head + 1");
  need("idb/wal.ts", /if \(head > now\.head\) passKeyGenerator\(records, head\);\s*meta\.put\(head, META_INGESTED\);/, "destroy moves the key generator with the head, and ingestedThrough holds the head");
  need("idb/wal.ts", /meta\.put\(Math\.max\(knownTop, top, generation\), META_TOP\)/, "adopt keeps the highest manifest number seen");
  need("recover.ts", /Math\.max\(numbers\[0\] \?\? 0, meta\.top, meta\.generation \?\? 0\)/, "new manifests number past every number in use");
  need("recover.ts", /m\.through > meta\.head && \(await isIntact\(fs, m\)\)/, "reconcile adopts an intact manifest past the head first");
  need("recover.ts", /if \(m === "corrupt"\) throw new CorruptDatabaseError\(`manifest \$\{recorded\} does not decode`\);\s*if \(m !== "missing"\) \{\s*if \(await isIntact\(fs, m\)\) return undefined;[\s\S]*?other\.through >= meta\.ingestedThrough && \(await isIntact\(fs, other\)\)\) return other;\s*\}\s*throw new CorruptDatabaseError/, "a recorded manifest that is there but broken is replaced only by one that holds every ingested seq, else recovery throws");
  need("host/engine-host.ts", /reconcile\(wal, fs, this\.trusted\)[\s\S]*liveRuns\(fs, generation\)/, "reclaim sweeps against the reconciled generation's runs");
  need("db.ts", /await timed\(trace, "generation", \(\) => reconcile\(wal, tabFs, "recorded"\)\);[\s\S]*await timed\(trace, "sync", \(\) => db\.sync\(\)\)/, "openDb reconciles before the first sync");
  need("db.ts", /private async syncOnce\(\): Promise<void> \{\s*await this\.retrying\(\(\) => this\.catchUpOnce\(\)\);[\s\S]*private async retrying[\s\S]*?holdingFiles\(this\.name, async \(\) => \{\s*for \([^)]*\) \{\s*const step = await attempt\(\);/, "sync retries under the reclaim lock and repairs when the recorded generation does not load");
  need("db.ts", /if \(step === "gone"\) \{\s*if \(\+\+gone >= GENERATION_RETRIES\)[^\n]*\n\s*await this\.repair\(\);/, "a load that finds files gone under the lock repairs");
  need("host/engine-host.ts", /ingestChunk\([^;]*this\.trusted[^;]*;\s*[^\n]*\n\s*await unlessHeld\(this\.name, \(\) => reclaimManifests\(fs, folded\.generation\)\)/, "a flush removes old manifests after recording, unless a tab holds the reclaim lock");
  need("host/engine-host.ts", /await unlessHeld\(this\.name, async \(\) => \{\s*const \{ generation \} = await reconcile\(wal, fs, this\.trusted\);[\s\S]*const live = await liveRuns\(fs, generation\);\s*await reclaimManifests\(fs, generation\);\s*await reclaimRuns\(fs, await listRuns\(fs\), live\)/, "reclaim reads the live runs, then removes manifests then runs, after reconciling, unless a tab holds the reclaim lock");
  need("host/compact.ts", /await raiseGeneration\(wal, generation\);\s*return generation;/, "install removes no file");
  need("recover.ts", /export async function recordEmpty[\s\S]*?highestThrough\(fs, numbers, meta\.head\)[\s\S]*?emptyWal\(wal, meta, floor \+ 1, top\)/, "destroy records generation 0 past every seq the WAL or a manifest names");
  need("idb/wal.ts", /async function emptyWal\([\s\S]*?durability: "strict"[\s\S]*?meta\.put\(top, META_DESTROYED_TOP\)/, "the destroy commit is strict and records destroyedTop");
  need("recover.ts", /for \(const n of numbers\) \{\s*if \(n <= meta\.destroyedTop\) break;/, "rule 3 adopts no manifest from before a destroy");
  need("host/engine-host.ts", /await recordEmpty\(wal, fs\);[\s\S]*?await unlessHeld\(this\.name, \(\) => reclaimManifests\(fs, Number\.POSITIVE_INFINITY\)\);\s*await this\.reclaim\(fs, wal\);/, "destroy commits, then removes the manifests and sweeps, each unless a tab holds the reclaim lock");
  return out;
}

function main(): void {
  console.log(`bound: workloads of up to ${MAX_CMDS} appends/ingests/compactions/destroys, every (IndexedDB, OPFS) prefix pair,`);
  console.log(`       then recovery + [${AFTER.join(", ")}] and every pair of the next crash, ${CRASHES} crashes deep`);
  console.log("property: PowerPrefix, ProcessAll, RecoveryStable, DestroyHolds");

  const drift = sourceSync();
  if (drift.length > 0) {
    console.error("\nFAIL source sync: the model no longer matches the product");
    for (const d of drift) console.error(`  ${d}`);
    process.exit(1);
  }

  const broken: [string, Variant][] = [
    ["ingest builds on the newest manifest file", { buildOnNewest: true }],
    ["adopting a manifest leaves head where it was", { noHeadRaise: true }],
    ["adopt moves the head and leaves the key generator behind", { adoptKeepsGenerator: true }],
    ["destroy moves the head and leaves the key generator behind", { destroyKeepsGenerator: true }],
    ["no fallback when the recorded manifest is gone", { noFallback: true }],
    ["a newer manifest past the head is never adopted", { noNewerAdopt: true }],
    ["a manifest number is reused after recovery records an older one", { reuseNumbers: true }],
    ["destroy removes the files before its commit", { destroyFilesFirst: true }],
    ["destroy commits at the default durability", { destroyRelaxed: true }],
    ["recovery falls back to a manifest from before a destroy", { fallBehindDestroy: true }],
  ];
  for (const [name, v] of broken) {
    const found = explore(v, MAX_CMDS, 1) ?? explore({ ...v, held: true }, MAX_CMDS, 1);
    if (!found) {
      console.error(`\nFAIL model too weak: the broken variant "${name}" passes`);
      process.exit(1);
    }
    console.log(`  broken variant caught: ${name}`);
  }

  const lossy = exploreCorrupt({ lossyRecovery: true }, MAX_CMDS);
  if (!lossy) {
    console.error(`\nFAIL model too weak: the broken variant "a missing run of the recorded manifest falls back like a missing manifest" passes`);
    process.exit(1);
  }
  console.log("  broken variant caught: a missing run of the recorded manifest falls back like a missing manifest");

  states = 0;
  const started = performance.now();
  const violation = explore({}, MAX_CMDS, 1) ?? explore({ held: true }, MAX_CMDS, 1);
  if (violation) {
    console.error(`\nFAIL PowerPrefix after ${states} crash states`);
    console.error(violation);
    process.exit(1);
  }
  console.log(`\nPASS PowerPrefix — ${states} crash states (${CRASHES} power losses deep) in ${Math.round(performance.now() - started)} ms`);

  const corrupt = exploreCorrupt({}, MAX_CMDS);
  if (corrupt) {
    console.error("\nFAIL CorruptRefuse");
    console.error(corrupt);
    process.exit(1);
  }
  console.log(`PASS CorruptRefuse — ${refusals} refusals that wrote nothing, ${standIns} lossless stand-ins`);
}

main();

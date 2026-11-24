/**
 * Exhaustive check: every power-loss crash state recovers to a log prefix,
 * including a second power loss during or after the first recovery.
 *
 * Run: pnpm --filter @opfs-lsm/kv formal:power-loss
 *
 * Every workload of up to MAX_CMDS appends, ingests (of every waiting
 * record, or of the oldest one: a chunk of a flush), compactions, destroys
 * and removals (`destroyDb`, then an open) runs on the model in model.ts.
 * For every triple (WAL database prefix, destroyed-row prefix, OPFS prefix)
 * of its durable ops: open (`reconcile`), read, recover (sweep, ingest,
 * compact), keep writing, and crash again at every triple of the recovery's
 * ops. Properties:
 * - PowerPrefix: every read is the state after one log prefix (the writes
 *   since its last destroy), and the database always opens;
 * - ProcessAll: a cut that is a prefix of the global order (a process
 *   crash) reads every acked write;
 * - RecoveryStable: recovery's ingest and compaction change no read, leave
 *   a healthy database (`checkDatabase`), and later writes read back.
 * Every workload runs twice: once with reclaim, and once with a tab holding
 * the reclaim lock throughout, so the host removes no manifest or run.
 * - DestroyHolds: a crash that keeps any op after the commit point of a
 *   destroy or a removal reads the state after it or later. The commit is
 *   strict, so no power loss keeps such an op without it (`possibleCut`).
 * - RemoveClean: from every crash state, `destroyDb` leaves no WAL database
 *   and no OPFS file, and an open after it reads empty.
 * - WalLost: after recovery and the writes that follow it are flushed,
 *   the browser throwing away the WAL database alone changes no read. A
 *   row a crash left in the row store never empties a database born after
 *   it.
 * Broken variants (build on the newest manifest, no head raise, an adopt or
 * a destroy that moves the head and not the key generator, no fallback, no
 * newer-manifest adoption, destroy files before its commit, a destroy
 * commit at the default durability, a fallback to a manifest whose runs are
 * gone, and six wrong removals or births) must
 * each fail, so the model is strong enough to see the bugs the crash suite
 * found.
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
import { cloneDisk, cloneOpfs, count, type Cut, DESTROYED, type Disk, eachKept, emptyDisk, possibleCut, Refused, replay, Stuck, Sys, type Op, type Variant } from "./model.js";

const MAX_CMDS = Number(process.env.FORMAL_POWER_CMDS ?? 6);
/** Power losses in a row: the first, then one during or after each recovery. */
const CRASHES = Number(process.env.FORMAL_POWER_CRASHES ?? 2);
type Cmd = "append" | "update" | "ingest" | "ingestOne" | "compact" | "destroy" | "remove";
const CMDS: Cmd[] = ["append", "ingest", "ingestOne", "compact", "destroy", "remove"];
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
  // After a removal, the next command opens the database again.
  if (cmd !== "remove" && sys.idb === undefined) sys.reconcile();
  if (cmd === "append") sys.append();
  else if (cmd === "update") sys.appendAfter();
  else if (cmd === "ingest") sys.ingest();
  else if (cmd === "ingestOne") sys.ingest(true);
  else if (cmd === "destroy") sys.destroy();
  else if (cmd === "remove") sys.remove();
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

/** Every cut of `ops` a power loss can leave. */
function* cuts(ops: readonly Op[]): Generator<Cut> {
  const n = count(ops);
  for (let idb = 0; idb <= n.idb; idb++) {
    for (let reg = 0; reg <= n.reg; reg++) {
      for (let opfs = 0; opfs <= n.opfs; opfs++) {
        const cut = { idb, reg, opfs };
        if (possibleCut(ops, cut)) yield cut;
      }
    }
  }
}

function describe(cut: Cut, ops: readonly Op[]): string {
  const n = count(ops);
  return `idb ${cut.idb}/${n.idb}, row ${cut.reg}/${n.reg}, opfs ${cut.opfs}/${n.opfs}`;
}

/** True when the cut keeps exactly the first k ops in global order for some k. */
function isProcessCut(ops: readonly Op[], cut: Cut): boolean {
  let gap = false;
  let ok = true;
  eachKept(ops, cut, (_, kept) => {
    if (kept && gap) ok = false;
    if (!kept) gap = true;
  });
  return ok;
}

/** Log entries in the ops a process cut keeps: acked write ids, and `DESTROYED` at each commit point. */
function committed(ops: readonly Op[], cut: Cut): number[] {
  const out: number[] = [];
  eachKept(ops, cut, (op, kept) => {
    if (!kept) return;
    if (op.store === "idb" && op.label.startsWith("append")) for (const [, id] of op.put ?? []) out.push(id);
    if (op.destroys) out.push(DESTROYED);
  });
  return out;
}

/**
 * DestroyHolds: the log entries a crash that keeps `cut` must read past. A
 * destroy or removal whose commit point came before a kept op of any store
 * stays done, so the read is the state after it or later.
 */
function destroyedBefore(ops: readonly Op[], cut: Cut): number {
  let entries = 0;
  let destroyed = 0;
  let through = 0;
  eachKept(ops, cut, (op, kept) => {
    if (op.store === "idb" && op.label.startsWith("append")) entries += op.put?.length ?? 0;
    if (op.destroys) destroyed = ++entries;
    if (kept) through = destroyed;
  });
  return through;
}

/** WalLost: once `sys` flushed every write, an open with no WAL database reads what `sys` reads. */
function walLost(sys: Sys, v: Variant, where: string): void {
  const flushed = new Sys(cloneDisk({ idb: sys.idb, reg: sys.reg, opfs: sys.opfs }), v, 950);
  run(flushed, "ingest");
  const want = read(flushed, `${where}: flushed`);
  const lost = new Sys(cloneDisk({ idb: undefined, reg: flushed.reg, opfs: flushed.opfs }), v, 960);
  const got = read(lost, `${where}: open after the WAL database is lost`);
  if (!same(got, want)) {
    throw new Violation(`${where}: with the WAL database lost, open read {${[...got].join(",")}}, not {${[...want].join(",")}}`);
  }
}

/** RemoveClean: `destroyDb` on the crash state `st` leaves no trace, and an open after it reads empty. */
function removeClean(st: Disk, v: Variant, where: string): void {
  const sys = new Sys(cloneDisk(st), v, 900);
  sys.remove();
  if (!sys.gone()) throw new Violation(`${where}: destroyDb left ${sys.idb ? "the WAL database" : "OPFS files"}`);
  const got = read(sys, `${where}: open after destroyDb`);
  if (got.size > 0) throw new Violation(`${where}: open after destroyDb read {${[...got].join(",")}}`);
}

let states = 0;

/**
 * Recover the crash state `st` of a run whose log was `log`, check it, and
 * when `depth` allows, crash again at every pair of the recovery's ops.
 */
function recover(st: Disk, log: readonly number[], mustHold: number | undefined, depth: number, v: Variant, where: string, destroyedThrough = 0): void {
  states++;
  removeClean(st, v, where);
  const sys = new Sys(cloneDisk(st), v, 1000 * depth + 1);
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
  walLost(sys, v, where);
  if (depth >= CRASHES) return;
  for (const cut of cuts(sys.ops)) {
    const proc = isProcessCut(sys.ops, cut) ? kept.length + committed(sys.ops, cut).length : undefined;
    recover(replay(st, sys.ops, cut), full, proc, depth + 1, v, `${where} → recovery crash (${describe(cut, sys.ops)})`, destroyedThrough);
  }
}

function checkWorkload(cmds: readonly Cmd[], v: Variant, depth: number): void {
  const sys = new Sys(emptyDisk(), v, 1);
  sys.reconcile();
  for (const c of cmds) run(sys, c);
  const empty = emptyDisk();
  for (const cut of cuts(sys.ops)) {
    const proc = isProcessCut(sys.ops, cut) ? committed(sys.ops, cut).length : undefined;
    const kept = (store: Op["store"]) => sys.ops.filter((x) => x.store === store).slice(0, cut[store]).map((x) => x.label).join(", ");
    const where = `[${cmds.join(" ")}] crash: the WAL database keeps [${kept("idb")}], the row store keeps [${kept("reg")}], OPFS keeps [${kept("opfs")}]`;
    recover(replay(empty, sys.ops, cut), sys.acked, proc, depth, v, where, destroyedBefore(sys.ops, cut));
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
  const live = new Sys(emptyDisk(), v, 1);
  live.reconcile();
  for (const c of cmds) run(live, c);
  if (!live.idb) return undefined;
  const gen = live.idb.generation ?? 0;
  const runs = gen === 0 ? [] : live.opfs.manifests.get(gen)!.runs;
  for (const path of runs) {
    const where = `[${cmds.join(" ")}] then run ${path} of manifest ${gen} removed`;
    const opfs = cloneOpfs(live.opfs);
    opfs.runs.delete(path);
    const { ingested } = live.idb;
    const standIn = [...opfs.manifests.values()].some((m) => m.through >= ingested && m.runs.every((p) => opfs.runs.has(p)));
    if (standIn) {
      const sys = new Sys({ ...cloneDisk(live), opfs }, v, 500);
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
      const sys = new Sys({ ...cloneDisk(live), opfs: cloneOpfs(opfs) }, v, 500);
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
  need("host/ingest.ts", /reconcile\(wal, fs, trusted\)[\s\S]*loadGeneration\(fs, base\.generation\)[\s\S]*nextGeneration\(base\.top\)[\s\S]*publishL0[\s\S]*publishGeneration[\s\S]*through: last[\s\S]*advanceIngested/, "ingest builds on the recorded generation and numbers past the top manifest");
  need("host/compact.ts", /reconcile\(wal, fs, trusted\)[\s\S]*loadGeneration\(fs, base\.generation\)[\s\S]*nextGeneration\(base\.top\)[\s\S]*through: meta\.through[\s\S]*raiseGeneration/, "install builds on the recorded generation");
  need("idb/wal.ts", /async function advanceIngested[\s\S]*delete\(IDBKeyRange\.upperBound\(existing\)\)/, "advanceIngested keeps the records it folds until the next ingest");
  need("idb/wal.ts", /Math\.max\(head, through, floor\)/, "adopt raises head past every seq a manifest names");
  need("idb/wal.ts", /async function headOf\(tx: IDBTransaction, after: Seq\): Promise<Seq> \{\s*const wal = tx\.objectStore\(WAL_STORE\);\s*if \(\(await reqToPromise\(wal\.getKey\(nextSeq\(after\)\)\)\) === undefined\) return after;\s*const last = await reqToPromise\(wal\.openKeyCursor\(IDBKeyRange\.lowerBound\(after, true\), "prev"\)\);\s*return asSeq\(Math\.max\(num\(last\?\.key\), after\)\);/, "the head is the floor when no record is at floor + 1, else the last WAL key");
  need("idb/wal.ts", /headOf\(tx, ingestedThrough\)[\s\S]*headOf\(tx, through\)[\s\S]*headOf\(tx, through\)/, "recovery and ingest look for the head past ingestedThrough");
  need("idb/wal.ts", /nextIngested = nextHead;\s*records\.delete\(IDBKeyRange\.upperBound\(head\)\);/, "an adopt that drops the records sets ingestedThrough to the new head, which is what holds it");
  need("idb/wal.ts", /if \(nextHead > head\) passKeyGenerator\(records, nextHead\);/, "adopt moves the key generator with the head, so no append takes a seq at or below it");
  need("idb/wal.ts", /const nextHead = follows \? head : asSeq\(Math\.max\(past, nextSeq\(head\)\)\);/, "an adopt that drops the records moves the head by at least one, so no seq names the state before the drop and the state after");
  need("idb/wal.ts", /group\.tx\.objectStore\(WAL_STORE\)\.add\(entry\.record\)/, "an append takes the seq the key generator hands out");
  need("idb/wal.ts", /const seq = nextSeq\(tail\.head\);\s*const record = encodeOps\(decision\.ops\);\s*tx\.objectStore\(WAL_STORE\)\.add\(record, seq\);/, "update appends at the explicit key head + 1");
  need("idb/wal.ts", /if \(head > now\.head\) passKeyGenerator\(records, head\);\s*meta\.put\(head, META_INGESTED\);/, "destroy moves the key generator with the head, and ingestedThrough holds the head");
  need("idb/wal.ts", /meta\.put\(Math\.max\(knownTop, top, generation\), META_TOP\)/, "adopt keeps the highest manifest number seen");
  need("recover.ts", /Math\.max\(numbers\[0\] \?\? GENERATION_NONE, meta\.top, meta\.generation \?\? GENERATION_NONE\)/, "new manifests number past every number in use");
  need("recover.ts", /m\.through > meta\.head && \(await isIntact\(fs, m\)\)/, "reconcile adopts an intact manifest past the head first");
  need("recover.ts", /if \(m === "corrupt"\) throw new CorruptDatabaseError\(`manifest \$\{recorded\} does not decode`\);\s*if \(m !== "missing"\) \{\s*if \(await isIntact\(fs, m\)\) return undefined;[\s\S]*?other\.through >= meta\.ingestedThrough && \(await isIntact\(fs, other\)\)\) return other;\s*\}\s*throw new CorruptDatabaseError/, "a recorded manifest that is there but broken is replaced only by one that holds every ingested seq, else recovery throws");
  need("host/engine-host.ts", /reconcile\(wal, fs, trusted\)[\s\S]*liveRuns\(fs, generation\)/, "reclaim sweeps against the reconciled generation's runs");
  need("db.ts", /const recovering = reconcileOpen\(wal, tabFs, \(\) => ingest\.repair\(name\)\);[\s\S]*await db\.boot\(recovering\);/, "openDb reconciles during its first catch-up, and the host writes what it finds to repair");
  need("recover.ts", /export async function reconcileOpen[\s\S]*?if \(meta\.generation !== undefined\) \{\s*if \(!\(await longerPrefix\(fs, meta, numbers\)\)\) return true;\s*\} else if \(numbers\.length === 0 && meta\.head === SEQ_ZERO && !\(await readDestroyed\(wal\.dbName\)\)\) \{\s*if \(await recordNew\(wal, meta\)\) return false;\s*\}\s*await repair\(\);\s*return false;/, "an open keeps the recorded manifest only when no intact manifest is past the head, records generation 0 itself only with no record, no manifest and no row, and has the host reconcile otherwise");
  need("recover.ts", /async function choose\([\s\S]*?const longer = await longerPrefix\(fs, meta, numbers\);\s*if \(longer\) return longer;/, "the open's check and reconcile share rule 1");
  need("idb/wal.ts", /export async function recordNew[\s\S]*?const same = sameMeta\(await readMeta\(tx\), expect\);\s*if \(same\) \{[\s\S]*?meta\.put\(expect\.ingestedThrough, META_INGESTED\);\s*meta\.put\(GENERATION_NONE, META_GENERATION\);\s*meta\.put\(expect\.top, META_TOP\);/, "a new database's generation 0 is what adopt writes for the empty manifest, and only while meta reads what the open read");
  need("host/engine-host.ts", /async function repair\(\): Promise<void> \{\s*await exclusive\(\(\) =>\s*withStores\(\s*async \(\{ wal, fs \}\) => \{\s*trusted = \(await reconcile\(wal, fs, undefined\)\)\.generation;/, "the host repairs for a tab in its exclusive section, with no generation trusted");
  need("db.ts", /private async repair\(\): Promise<void> \{\s*await this\.ingestClient\.repair\(this\.name\);\s*this\.repaired = true;/, "a tab whose load finds files gone has the host reconcile");
  need("db.ts", /const \[kept, tail\] = await Promise\.all\(\[recovering, reading\.catch\(\(\) => undefined\)\]\);\s*if \(tail && kept && \(await this\.follow\(tail\)\) === "done"\) return;[\s\S]*?await this\.sync\(\);/, "openDb applies the tail it read meanwhile only when reconcile wrote nothing, and reads again otherwise");
  need("recover.ts", /if \(!pick\) return \{ generation: meta\.generation!, top, kept: true \};[\s\S]*?kept: false \} : undefined;/, "reconcile reports kept only when it wrote nothing");
  need("db.ts", /if \(known && !\(await loadGeneration\(this\.fs, generation\)\)\) gone = true;/, "a load from the manifest copy fails without the manifest file");
  need("db.ts", /private async syncOnce\(\): Promise<void> \{\s*await this\.retrying\(\(\) => this\.catchUpOnce\(\)\);[\s\S]*private async retrying[\s\S]*?holdingFiles\(this\.name, async \(\) => \{\s*for \([^)]*\) \{\s*const step = await attempt\(\);/, "sync retries under the reclaim lock and repairs when the recorded generation does not load");
  need("db.ts", /if \(step === "gone"\) \{\s*if \(\+\+gone >= GENERATION_RETRIES\)[^\n]*\n\s*await this\.repair\(\);/, "a load that finds files gone under the lock repairs");
  need("host/engine-host.ts", /ingestChunk\([^;]*trusted[^;]*;\s*[^\n]*\n\s*await unlessHeld\(name, \(\) => reclaimManifests\(fs, folded\.generation\)\)/, "a flush removes old manifests after recording, unless a tab holds the reclaim lock");
  need("host/engine-host.ts", /await unlessHeld\(name, async \(\) => \{\s*const \{ generation \} = await reconcile\(wal, fs, trusted\);[\s\S]*const live = await liveRuns\(fs, generation\);\s*await reclaimManifests\(fs, generation\);\s*await reclaimRuns\(fs, await listRuns\(fs\), live\)/, "reclaim reads the live runs, then removes manifests then runs, after reconciling, unless a tab holds the reclaim lock");
  need("host/compact.ts", /await raiseGeneration\(wal, generation, manifest\);\s*return generation;/, "install removes no file");
  need("recover.ts", /export async function recordEmpty[\s\S]*?const floor = atLeast\(known, \{ head: nextSeq\(await highestThrough\(fs, numbers, meta\.head\)\), top \}\);\s*const head = await emptyWal\(wal, \{ expect: meta, \.\.\.floor, pastAppends: true \}\);/, "destroy records generation 0 past every seq the WAL or a manifest names, and past a row already there");
  need("idb/wal.ts", /async function emptyWal\([\s\S]*?durability: "strict"[\s\S]*?const head = appended \? asSeq\(Math\.max\(emptied\.head, nextSeq\(now\.head\)\)\) : emptied\.head;[\s\S]*?meta\.put\(top, META_DESTROYED_TOP\)/, "the destroy commit is strict and records destroyedTop");
  need("recover.ts", /for \(const n of numbers\) \{\s*if \(n <= meta\.destroyedTop\) break;\s*const m = await probeManifest\(fs, n\);\s*if \(m === "corrupt"\)[^\n]*\n\s*if \(m !== "missing" && \(await isIntact\(fs, m\)\)\) return m;/, "rule 3 adopts no manifest from before a destroy, and skips one whose runs are gone");
  need("host/engine-host.ts", /await recordEmpty\(wal, fs, undefined\);[\s\S]*?await unlessHeld\(name, \(\) => reclaimManifests\(fs, asGeneration\(Number\.POSITIVE_INFINITY\)\)\);\s*await reclaim\(fs, wal\);/, "destroy commits, then removes the manifests and sweeps, each unless a tab holds the reclaim lock");
  need("destroy.ts", /withLock\(openLock\(name\),[\s\S]*?withLock\(compactLock\(name\),[\s\S]*?withLock\(ingestLock\(name\),[\s\S]*?const files = await findFiles\(\);\s*const wal = await openAlone\(name\);[\s\S]*?if \(!wal && !files\) return;\s*const known = await readDestroyed\(name\);\s*const floor = wal \? await recordEmpty\(wal, files, known\) : await floorOfFiles\(files!, known\);\s*if \(floor\) await recordDestroyed\(name, floor\);\s*await files\?\.removeFolder\(\);\s*if \(wal\) await deleteWal\(wal\);/, "destroyDb fences, commits empty, writes the row, removes the files, then deletes the WAL database");
  need("idb/destroyed.ts", /export async function recordDestroyed[\s\S]*?durability: "strict"[\s\S]*?Math\.max\(old\?\.head \?\? 0, floor\.head\), top: Math\.max\(old\?\.top \?\? 0, floor\.top\)/, "the row is written strict and never moves down");
  need("destroy.ts", /async function openAlone[\s\S]*?openDatabase\(idbName\(name\), \{ version: version \+ 1 \}\)/, "destroyDb opens the WAL database one version up, which closes every other connection");
  need("recover.ts", /if \(meta\.generation === undefined\) \{\s*const known = await readDestroyed\(wal\.dbName\);\s*if \(known\) \{\s*(\/\/[^\n]*\n\s*)*const outgrown = \(numbers\[0\] \?\? GENERATION_NONE\) > known\.top;\s*const born = outgrown \? known : atLeast\(known, \{ head: nextSeq\(await highestThrough\(fs, numbers, meta\.head\)\), top \}\);\s*if \(\(await emptyWal\(wal, \{ expect: meta, \.\.\.born \}\)\) === undefined\) return undefined;[^\n]*\n(\s*\/\/[^\n]*\n)*\s*await forgetDestroyed\(wal\.dbName, known\);\s*(\/\/[^\n]*\n\s*)*if \(outgrown\) return undefined;/, "rule 0: a WAL database with no generation and a row is born past the row, strict, before the row is forgotten; a manifest past the row's top births at the row and runs rules 1 to 3");
  need("recover.ts", /export async function floorOfFiles[\s\S]*?if \(numbers\.length === 0\) return undefined;\s*return atLeast\(known, \{ head: nextSeq\(await highestThrough\(fs, numbers, SEQ_ZERO\)\), top: numbers\[0\]! \}\);/, "with no WAL database, the row comes from the manifests on disk");
  need("opfs/browser-fs.ts", /class RemovableBrowserFs extends BrowserFs[\s\S]*?async removeFolder\(\): Promise<void> \{\s*await ignoreNotFound\(\(await this\.root\)\.removeEntry\("m", \{ recursive: true \}\)\);\s*await ignoreNotFound\(this\.parent\.removeEntry\(this\.dbName, \{ recursive: true \}\)\);/, "the folder removal takes m/ first, then the folder");
  need("host/shared-worker.ts", /new EngineHost\(\(name\) => findBrowserFs\(name\)\)/, "the SharedWorker host finds the folder and never creates it");
  need("host/engine-host.ts", /const wal = await IdBWal\.openExisting\(name\);/, "the host opens the WAL database only if it exists");
  for (const [file, re, what] of [
    ["host/engine-host.ts", /TabWal\.open|openBrowserFs|\{ create:/, "the host creates no store"],
    ["host/shared-worker.ts", /openBrowserFs/, "the SharedWorker creates no folder"],
  ] as const) {
    if (re.test(read(file))) out.push(`${file}: ${what}`);
  }
  return out;
}

function main(): void {
  console.log(`bound: workloads of up to ${MAX_CMDS} appends/ingests/compactions/destroys/removals, every (WAL database, row, OPFS) prefix triple,`);
  console.log(`       then recovery + [${AFTER.join(", ")}] and every triple of the next crash, ${CRASHES} crashes deep`);
  console.log("property: PowerPrefix, ProcessAll, RecoveryStable, DestroyHolds, RemoveClean, WalLost");

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
    ["recovery falls back to a manifest whose runs are gone", { fallBackToBroken: true }],
    ["destroyDb writes no row", { removeNoRow: true }],
    ["destroyDb writes the row at the default durability", { rowRelaxed: true }],
    ["recovery ignores the row", { birthIgnoresRow: true }],
    ["rule 0 takes its floor from the files on disk", { birthFloorFromDisk: true }],
    ["rule 0 commits at the default durability, then forgets the row", { birthRelaxed: true }],
    ["rule 0 births past a row that a later database outgrew", { birthOverOutgrown: true }],
    ["destroyDb deletes the WAL database before it writes the row", { dropFirst: true }],
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
  console.log(`PASS RemoveClean — destroyDb from each of the ${states} crash states left no WAL database and no file`);
  console.log(`PASS WalLost — losing only the WAL database after each of the ${states} recoveries changed no read`);

  const corrupt = exploreCorrupt({}, MAX_CMDS);
  if (corrupt) {
    console.error("\nFAIL CorruptRefuse");
    console.error(corrupt);
    process.exit(1);
  }
  console.log(`PASS CorruptRefuse — ${refusals} refusals that wrote nothing, ${standIns} lossless stand-ins`);
}

main();

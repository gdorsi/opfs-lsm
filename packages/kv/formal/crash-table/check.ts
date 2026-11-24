/**
 * Exhaustive check of the power-loss table of design.md, "Crash behavior":
 * the rows that promise more than a log prefix.
 *
 * Run: pnpm --filter @opfs-lsm/kv formal:crash-table
 *
 * PowerPrefix (formal/power-loss) proves that every power-loss state reads
 * some log prefix. The empty prefix passes it, so it says nothing of how
 * much a power loss may take. The table says more, and the write order of
 * a flush exists for it ("Truncation": the WAL keeps the seqs the last
 * ingest folded). On the model of formal/power-loss/model.ts, for every
 * workload of appends, updates, flushes (of every waiting record, or of the
 * oldest one) and compactions, and every pair (IndexedDB prefix, OPFS
 * prefix) of its durable ops:
 *
 * - FlushKept (rows 1 and 2): when OPFS lost the run or manifest of at most
 *   one flush whose commit IndexedDB kept, the open reads every append
 *   IndexedDB kept. "The previous manifest is intact, and the WAL still
 *   holds the seqs that flush folded. Nothing is lost." Past one such flush
 *   the WAL is dropped, and the row promises nothing.
 * - ManifestKept (rows 3 and 4): the open reads every write of every
 *   manifest that OPFS kept with all its runs, whatever IndexedDB lost.
 *
 * Every workload runs with reclaim and with a tab holding the reclaim lock.
 * Destroys are left out: DestroyHolds in formal/power-loss owns their rows.
 *
 * Broken variants (a flush that truncates the records it just folded, and
 * a recovery that never adopts a manifest past the head) must each fail.
 * The first passes PowerPrefix, RemoveClean, WalLost and CorruptRefuse.
 */
import { cloneDisk, count, type Cut, type Disk, eachKept, emptyDisk, type Op, possibleCut, Refused, replay, Stuck, Sys, type Variant } from "../power-loss/model.js";

const MAX_CMDS = Number(process.env.FORMAL_TABLE_CMDS ?? 6);

type Cmd = "append" | "update" | "ingest" | "ingestOne" | "compact";
const CMDS: readonly Cmd[] = ["append", "update", "ingest", "ingestOne", "compact"];

type Model = new (disk: Disk, v: Variant, nextId: number) => Sys;

/** Broken: the flush commit deletes the records it folded, not the ones the flush before it folded. */
class TruncatesFolded extends Sys {
  override ingest(oldestOnly = false): void {
    const from = this.ops.length;
    super.ingest(oldestOnly);
    for (let i = from; i < this.ops.length; i++) {
      const op = this.ops[i]!;
      if (op.store !== "idb" || op.ingested === undefined || !op.label.startsWith("advanceIngested")) continue;
      this.ops[i] = { ...op, deleteTo: op.ingested };
      for (const seq of [...this.idb!.rows.keys()]) if (seq <= op.ingested) this.idb!.rows.delete(seq);
    }
  }
}

/** Shortest first, so a failure prints a shortest workload. */
function* workloads(max: number): Generator<Cmd[]> {
  let level: Cmd[][] = [[]];
  for (let length = 1; length <= max; length++) {
    level = level.flatMap((prefix) => CMDS.map((c) => [...prefix, c]));
    yield* level;
  }
}

function run(sys: Sys, cmd: Cmd): void {
  if (cmd === "append") sys.append();
  else if (cmd === "update") sys.appendAfter();
  else if (cmd === "ingest") sys.ingest();
  else if (cmd === "ingestOne") sys.ingest(true);
  else sys.compact();
}

function* cuts(ops: readonly Op[]): Generator<Cut> {
  const n = count(ops);
  for (let idb = 0; idb <= n.idb; idb++) {
    for (let opfs = 0; opfs <= n.opfs; opfs++) {
      const cut = { idb, reg: n.reg, opfs };
      if (possibleCut(ops, cut)) yield cut;
    }
  }
}

/** What the table lets a crash that keeps `cut` promise: the appends IndexedDB kept, and how many kept flush commits lost their files. */
function kept(ops: readonly Op[], cut: Cut): { readonly appends: number[]; readonly lostFlushes: number } {
  const appends: number[] = [];
  let lostFlushes = 0;
  /** Whether OPFS kept the last manifest published so far: a flush publishes its run, then its manifest, then commits. */
  let manifestKept = true;
  eachKept(ops, cut, (op, isKept) => {
    if (op.store === "opfs" && op.manifest) manifestKept = isKept;
    if (op.store !== "idb" || !isKept) return;
    if (op.label.startsWith("append")) for (const [, id] of op.put ?? []) appends.push(id);
    if (op.label.startsWith("advanceIngested") && !manifestKept) lostFlushes++;
  });
  return { appends, lostFlushes };
}

/** The writes of every manifest of `disk` that has all its runs. */
function intactManifests(disk: Disk): { readonly gen: number; readonly ids: number[] }[] {
  const out: { gen: number; ids: number[] }[] = [];
  for (const m of disk.opfs.manifests.values()) {
    if (!m.runs.every((p) => disk.opfs.runs.has(p))) continue;
    out.push({ gen: m.gen, ids: m.runs.flatMap((p) => disk.opfs.runs.get(p)!.map((w) => w.id)) });
  }
  return out;
}

let states = 0;

/** The first crash state of `cmds` that breaks a row of the table, or undefined. */
function checkWorkload(cmds: readonly Cmd[], Model: Model, v: Variant): string | undefined {
  const sys = new Model(emptyDisk(), v, 1);
  sys.reconcile();
  for (const c of cmds) run(sys, c);
  const empty = emptyDisk();
  for (const cut of cuts(sys.ops)) {
    states++;
    const crashed = replay(empty, sys.ops, cut);
    const where = () => {
      const of = (store: Op["store"]) => sys.ops.filter((x) => x.store === store).slice(0, cut[store]).map((x) => x.label).join(", ");
      return `[${cmds.join(" ")}] crash: the WAL database keeps [${of("idb")}], OPFS keeps [${of("opfs")}]`;
    };
    let read: Set<number>;
    try {
      read = new Model(cloneDisk(crashed), v, 1000).read();
    } catch (err) {
      if (err instanceof Stuck || err instanceof Refused) return `${where()}: does not open (${err.message})`;
      throw err;
    }
    const list = [...read].sort((a, b) => a - b).join(",");
    const { appends, lostFlushes } = kept(sys.ops, cut);
    if (lostFlushes <= 1) {
      const lost = appends.filter((id) => !read.has(id));
      if (lost.length > 0) {
        return `${where()}: FlushKept: IndexedDB kept the appends {${appends.join(",")}} and OPFS lost the files of ${lostFlushes} flush, and the open reads {${list}}`;
      }
    }
    for (const m of intactManifests(crashed)) {
      const lost = m.ids.filter((id) => !read.has(id));
      if (lost.length > 0) {
        return `${where()}: ManifestKept: manifest ${m.gen} is on disk with its runs and holds {${m.ids.join(",")}}, and the open reads {${list}}`;
      }
    }
  }
  return undefined;
}

function explore(Model: Model, v: Variant): string | undefined {
  for (const cmds of workloads(MAX_CMDS)) {
    const found = checkWorkload(cmds, Model, v) ?? checkWorkload(cmds, Model, { ...v, held: true });
    if (found) return found;
  }
  return undefined;
}

console.log(`bound: workloads of up to ${MAX_CMDS} appends/updates/flushes/compactions, every (WAL database, OPFS) prefix pair, with and without reclaim`);
console.log("property: FlushKept, ManifestKept (design.md, the power-loss table of \"Crash behavior\")");

const broken: [string, Model, Variant][] = [
  ["a flush truncates the records it just folded", TruncatesFolded, {}],
  ["a newer manifest past the head is never adopted", Sys, { noNewerAdopt: true }],
];
for (const [name, Model, v] of broken) {
  const found = explore(Model, v);
  if (!found) {
    console.error(`\nFAIL model too weak: the broken variant "${name}" passes`);
    process.exit(1);
  }
  console.log(`  broken variant caught: ${name}`);
  console.log(`    ${found}`);
}

states = 0;
const started = performance.now();
const violation = explore(Sys, {});
if (violation) {
  console.error(`\nFAIL CrashTable after ${states} crash states`);
  console.error(violation);
  console.error("\nHarm: a power loss takes acked writes that both stores together still held.");
  process.exit(1);
}
console.log(`\nPASS CrashTable — ${states} crash states in ${Math.round(performance.now() - started)} ms: FlushKept, ManifestKept`);

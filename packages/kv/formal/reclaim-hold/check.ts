/**
 * Exhaustive check: under compaction churn, a tab never reads a removed run
 * and a healthy database never counts toward `CorruptDatabaseError`.
 *
 * Run: pnpm --filter @opfs-lsm/kv exec tsx formal/reclaim-hold/check.ts
 *
 * One tab syncs and opens views while one host flushes, compacts, destroys
 * and sweeps, every removal a step of its own (model.ts). Properties, in
 * every state:
 * - HeldStays: every run the tab holds open, the installed generation's
 *   included, is on disk;
 * - ViewHolds: every run of the generation an open view reads is on disk;
 * - LockedLoad: a retry never finds a file gone (design.md: "Under the
 *   lock, no removal can run, so the manifest and every run of the recorded
 *   generation are on disk and the load succeeds"), so `GENERATION_RETRIES`
 *   is reached only by a database that is corrupt;
 *
 * Broken variants (a retry with no reclaim lock, a retry that locks after
 * its tail read, a run checked before it is locked, a host that removes
 * under a tab's reclaim lock or run lock, a view that retains nothing) must
 * each fail.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copy, enabled, encode, initial, step, violation, type Action, type Bounds, type State, type Variant } from "./model.js";

const BOUNDS: Bounds = {
  installs: Number(process.env.FORMAL_RECLAIM_INSTALLS ?? 3),
  idleSweeps: 1,
  syncs: Number(process.env.FORMAL_RECLAIM_SYNCS ?? 3),
  views: 2,
};

let states = 0;

/** Breadth first over every interleaving. The shortest path to a violation, or undefined. */
function explore(v: Variant): string | undefined {
  type Node = { state: State | undefined; readonly prev: number; readonly action: Action | undefined };
  const nodes: Node[] = [{ state: initial(BOUNDS), prev: -1, action: undefined }];
  const seen = new Set<string>([encode(nodes[0]!.state!)]);
  for (let i = 0; i < nodes.length; i++) {
    const state = nodes[i]!.state!;
    nodes[i]!.state = undefined;
    const actions = enabled(state);
    const found = violation(state);
    if (found) {
      const trail: Action[] = [];
      for (let j = i; j > 0; j = nodes[j]!.prev) trail.push(nodes[j]!.action!);
      const replayed = initial(BOUNDS);
      const steps = trail.reverse().map((a, n) => `  ${n + 1}. ${step(replayed, a, v)}`);
      return [found, "shortest path:", ...steps].join("\n");
    }
    for (const action of actions) {
      const next = copy(state);
      step(next, action, v);
      const key = encode(next);
      if (seen.has(key)) continue;
      seen.add(key);
      nodes.push({ state: next, prev: i, action });
    }
  }
  states = seen.size;
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
  need("host/protocol.ts", /export function holdingFiles<T>\(name: string, fn: \(\) => Promise<T>\): Promise<T> \{\s*return withLock\(reclaimLock\(name\), fn, "shared"\);/, "a tab holds the reclaim lock shared");
  need(
    "host/protocol.ts",
    /export async function unlessHeld[\s\S]*?manager\.request\(reclaimLock\(name\), \{ mode: "exclusive", ifAvailable: true \}, async \(lock\) => \{\s*if \(!lock\) return false;\s*await fn\(\);/,
    "the host removes under the reclaim lock taken exclusively, only when available",
  );
  need(
    "db.ts",
    /const first = await attempt\(\);\s*if \(finished\(first\)\) return first;\s*return holdingFiles\(this\.name, async \(\) => \{\s*for \(let gone = 0; ; \) \{\s*const step = await attempt\(\);/,
    "the first attempt takes no reclaim lock, and every retry runs whole under it",
  );
  need("db.ts", /this\.retrying<"done">\(\(\) =>\s*this\.closed \? Promise\.resolve\("done"\) : this\.wal\.tail\(this\.mem\.appliedThrough, this\.installed\.generation\)\.then\(\(tail\) => this\.follow\(tail\)\),/, "an attempt reads the tail inside the attempt");
  need(
    "db.ts",
    /let run = this\.runs\.get\(path\);\s*if \(!run\) \{\s*const opened = early\?\.get\(path\);\s*early\?\.delete\(path\);\s*const file = await \(opened \?\? this\.fs\.open\(path\)\);\s*if \(!file\) return undefined;/,
    "openRun reuses a run the tab holds open, else takes the one its open opened ahead, else opens it",
  );
  need(
    "db.ts",
    /const \{ head \} = this;\s*this\.head = undefined;[\s\S]*?this\.openRun\(paths\[i\]!, i, manifest, head\?\.files\)/,
    "only the first load of an open takes the runs opened ahead, so a retry under the reclaim lock opens its own",
  );
  need("db.ts", /const file = fs\.open\(path\);\s*file\.catch\(\(\) => undefined\);\s*head\.files\.set\(path, file\);/, "a run opened ahead of IndexedDB is opened as any other, under its shared lock");
  need(
    "db.ts",
    /\} finally \{[^}]*head\.taken = true;\s*head\.manifest = undefined;\s*for \(const file of head\.files\.values\(\)\) file\.then\(\(f\) => f\?\.close\(\)\)/,
    "an open closes the runs it opened ahead that no load took",
  );
  need("db.ts", /if \(--run\.layers > 0\) continue;\s*this\.runs\.delete\(run\.path\);\s*run\.reader\.close\(\);\s*run\.file\.close\(\);/, "a run closes when no layers hold it");
  need("db.ts", /if \(layers\) \{\s*this\.release\(this\.installed\);\s*this\.installed = layers;/, "the old layers are released only once the new ones are installed");
  need(
    "db.ts",
    /const layers = this\.installed;\s*this\.retain\(layers\);\s*const snap = new ViewSnapshotImpl\([\s\S]*?\} finally \{\s*snap\.close\(\);\s*this\.release\(layers\);/,
    "a view retains its layers until its callback ends",
  );
  need(
    "opfs/browser-fs.ts",
    /\.request\(this\.lockName\(path\), \{ mode: "shared" \}, \(\) => \{\s*granted\(\);\s*return held;\s*\}\)[\s\S]*?let file: File;\s*try \{\s*file = await \(await handle\)\.getFile\(\);/,
    "open takes the shared run lock, then checks that the file exists",
  );
  need(
    "opfs/browser-fs.ts",
    /async removeUnlessOpen\(path: string\): Promise<boolean> \{\s*return await navigator\.locks\.request\(\s*this\.lockName\(path\),\s*\{ mode: "exclusive", ifAvailable: true \},\s*async \(lock\) => \{\s*if \(!lock\) return false;/,
    "a run goes only under its run lock taken exclusively, when available",
  );
  need("store/generation.ts", /if \(retained\.has\(path\)\) continue;\s*await fs\.removeUnlessOpen\(path\)/, "reclaimRuns removes a run only through removeUnlessOpen");
  need("store/generation.ts", /if \(m\[2\] \? n > keepFrom : n >= keepFrom\) continue;/, "reclaimManifests keeps the recorded manifest and every newer one");
  const host = read("host/engine-host.ts");
  const removals = host.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "").match(/reclaimManifests\(|reclaimRuns\(|removeUnlessOpen\(|\bsweep\(fs/g)?.length ?? 0;
  // A flush and a destroy call reclaimManifests under unlessHeld, reclaim and sweepIdle call sweep under it, and sweep
  // (declared once) calls reclaimManifests and reclaimRuns: 3 + 1 + 3.
  if (removals !== 7) out.push(`host/engine-host.ts: the host removes files at ${removals} sites, the model knows 7`);
  need("host/engine-host.ts", /await unlessHeld\(name, \(\) => reclaimManifests\(fs, folded\.generation\)\);/, "a flush removes manifests under unlessHeld");
  need("host/engine-host.ts", /await unlessHeld\(name, \(\) => reclaimManifests\(fs, asGeneration\(Number\.POSITIVE_INFINITY\)\)\);\s*await reclaim\(fs, wal\);/, "a destroy removes every manifest, then sweeps, under unlessHeld");
  need("host/engine-host.ts", /async function reclaim\(fs: AsyncFs, wal: IdBWal\): Promise<void> \{\s*await unlessHeld\(name, async \(\) => \{/, "reclaim runs under unlessHeld");
  need("host/engine-host.ts", /async function sweepIdle\(fs: AsyncFs, wal: IdBWal\): Promise<void> \{\s*await unlessHeld\(name, async \(\) => \{/, "sweepIdle runs under unlessHeld");
  return out;
}

const drift = sourceSync();
if (drift.length > 0) {
  console.error("FAIL source sync: the model no longer matches the product");
  for (const d of drift) console.error(`  ${d}`);
  process.exit(1);
}

console.log(`bound: ${BOUNDS.installs} installs (flush, compaction or destroy), ${BOUNDS.idleSweeps} idle sweep, ${BOUNDS.syncs} syncs, ${BOUNDS.views} views`);
const broken: [string, Variant][] = [
  ["a retry takes no reclaim lock", { retryUnlocked: true }],
  ["a retry takes the reclaim lock after its tail read", { lockAfterTail: true }],
  ["open checks that a run exists before it takes the run lock", { checkBeforeLock: true }],
  ["the host removes while a tab holds the reclaim lock", { hostIgnoresReclaimLock: true }],
  ["the host removes a run a tab holds open", { hostIgnoresRunLock: true }],
  ["a view retains no layers", { viewNoRetain: true }],
];
for (const [name, v] of broken) {
  if (!explore(v)) {
    console.error(`FAIL model too weak: the broken variant "${name}" passes`);
    process.exit(1);
  }
  console.log(`  broken variant caught: ${name}`);
}

const found = explore({});
if (found) {
  console.error("FAIL ReclaimHold");
  console.error(found);
  console.error("\nHarm: a tab reads a run the host removed, or a healthy database under churn throws CorruptDatabaseError.");
  process.exit(1);
}
console.log(`PASS ReclaimHold — ${states} states: HeldStays, ViewHolds, LockedLoad`);

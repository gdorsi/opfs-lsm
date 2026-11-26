/**
 * GenSwitch: a tab that follows the log through flushes, compactions and
 * destroys reads one log prefix, never goes back, and its `changes()` feed
 * names every seq it applies once, in order, whichever way its calls, its
 * messages and the host interleave.
 *
 * Run: pnpm --filter @opfs-lsm/kv formal:gen-switch
 *
 * One tab with a `sync`, a `put` and a `write` (the `appendAfter` of
 * `update`) in flight at once, BroadcastChannel messages that come in order
 * or never, another tab that appends, and a host that flushes (every
 * waiting record, or the oldest), compacts and destroys (model.ts).
 * Properties, in every state:
 * - PrefixExact (design.md, "Memtable": "the memtable is therefore always one
 *   exact prefix of the log. Every read depends on this"): each key reads
 *   the state after `appliedThrough`, with a destroy as one entry that
 *   deletes every key;
 * - Monotone: `appliedThrough` never goes back;
 * - WalGap: no catch-up of a healthy database throws `wal gap`;
 * - FeedOnce, FeedNoLoss, FeedComplete, FeedRebuild (design.md, "Change
 *   events"; src/changes.ts): when the events are announced, each applied
 *   seq has one `append` or a `gap` that covers it, in seq order, and a copy
 *   rebuilt from them reads what the tab reads;
 * - ReadYourWrites: a put or a write resolves with the memtable at or past
 *   its seq;
 * - every call ends, within a bounded number of attempts once the host stops.
 *
 * Broken variants must each fail: a flush that records ingestedThrough
 * before its generation, a stale tail's generation installed, `has` that
 * ignores `ahead`, an advance whatever generation is installed, and a jump
 * with no gap event.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copy, enabled, encode, initial, monotone, reached, step, violation, type Action, type Bounds, type State, type Variant } from "./model.js";

const BOUNDS: Bounds = {
  appends: Number(process.env.FORMAL_SWITCH_APPENDS ?? 2),
  installs: Number(process.env.FORMAL_SWITCH_INSTALLS ?? 2),
  syncs: 1,
  puts: 1,
  writes: 1,
};

let states = 0;

/** Breadth first over every interleaving. The shortest path to a violation, or undefined. */
function explore(v: Variant, b: Bounds): string | undefined {
  type Node = { state: State | undefined; readonly prev: number; readonly action: Action | undefined };
  const nodes: Node[] = [{ state: initial(b), prev: -1, action: undefined }];
  const seen = new Set<string>([encode(nodes[0]!.state!)]);
  const trail = (i: number) => {
    const path: Action[] = [];
    for (let j = i; j > 0; j = nodes[j]!.prev) path.push(nodes[j]!.action!);
    const replayed = initial(b);
    return path.reverse().map((a, n) => `  ${n + 1}. ${step(replayed, a, b, v)}`);
  };
  for (let i = 0; i < nodes.length; i++) {
    const state = nodes[i]!.state!;
    nodes[i]!.state = undefined;
    const actions = enabled(state);
    const found = violation(state, actions.length);
    if (found) return [found, "shortest path:", ...trail(i)].join("\n");
    for (const action of actions) {
      const next = copy(state);
      step(next, action, b, v);
      const back = monotone(state, next);
      if (back) return [back, "shortest path:", ...trail(i), `  then ${step(copy(state), action, b, v)}`].join("\n");
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
  need(
    "db.ts",
    /const behind = tail\.ingestedThrough > this\.mem\.appliedThrough;\s*const layers = this\.loaded\?\.generation === tail\.generation \? this\.loaded : undefined;[\s\S]*?if \(\s*\(tail\.generation > this\.installed\.generation && !this\.old\(tail\)\) \|\|\s*\(behind && tail\.generation < this\.installed\.generation\)\s*\) \{\s*if \(layers\) \{\s*this\.release\(this\.installed\);\s*this\.installed = layers;\s*this\.loaded = undefined;\s*\} else if \(behind\) \{\s*return tail\.generation;\s*\}\s*\}\s*if \(this\.loaded && \(this\.loaded\.generation <= this\.installed\.generation \|\| this\.loaded === layers\)\) \{\s*this\.release\(this\.loaded\);\s*this\.loaded = undefined;\s*\}\s*if \(this\.installed\.generation === tail\.generation\) \{\s*this\.advance\(tail\.ingestedThrough\);\s*\}\s*for \(const record of tail\.records\) \{\s*if \(this\.applyRecord\(record\) === "gap"\) \{/,
    "catchUp installs a loaded generation by the rule the model encodes, advances only to its own generation's ingestedThrough, then applies the records",
  );
  need(
    "db.ts",
    /layers !== undefined &&\s*\(layers\.generation === generation \|\| \(layers\.generation > generation && !ahead\)\)/,
    "has counts a lower generation as held only when the tail is not ahead",
  );
  need("db.ts", /return tail\.ingestedThrough < this\.mem\.ingestedThrough;/, "old compares the tail's ingestedThrough with the memtable's");
  need("db.ts", /if \(this\.mem\.advanceTo\(through\) \|\| this\.repaired\) \{\s*this\.repaired = false;\s*this\.unannounced\.push\(\{ kind: "gap", through: this\.mem\.appliedThrough \}\);/, "advance announces a gap when the memtable jumps");
  need(
    "db.ts",
    /if \(tail\.generation !== this\.installed\.generation && !this\.old\(tail\)\) \{\s*const ahead = tail\.ingestedThrough > this\.mem\.appliedThrough;\s*whole = await this\.load\(tail\.generation, ahead, tail\.manifest\);/,
    "follow loads a tail's generation unless it is installed or the tail is old",
  );
  need("db.ts", /private async load\([^)]*\): Promise<boolean> \{\s*if \(this\.has\(generation, ahead\)\) return true;/, "load returns at once for a generation the tab has");
  need("db.ts", /\|\| this\.closed \|\| this\.has\(generation, ahead\)\) \{\s*this\.dropRuns\(held\);/, "load asks has again after its awaits");
  need("db.ts", /if \(missing !== undefined\) return \(await this\.load\(missing, true\)\) \? "behind" : "gone";/, "write loads a missing generation as ahead, then tries again");
  need("db.ts", /=== "gap"\) \{\s*void this\.sync\(\)\.catch\(\(\) => undefined\);\s*break;/, "a BroadcastChannel row past a gap syncs");
  need("db.ts", /=== "gap" && ops\.length && !this\.closed\) await this\.sync\(\);/, "a landing past a gap waits for a sync");
  need("store/memtable.ts", /const jumped = through > this\.applied;[\s\S]*?this\.applied = through > this\.applied \? through : this\.applied;\s*this\.rebuild\(jumped \? \[\] : this\.chunks\.flat\(\)\.filter\(\(row\) => row\.seq > through\)\);/, "advanceTo drops the rows at or below through, every row when it jumps");
  need("store/memtable.ts", /if \(record\.seq <= this\.applied\) return "already";\s*if \(record\.seq !== nextSeq\(this\.applied\)\) return "gap";/, "apply takes only the next seq");
  need("turns.ts", /if \(running\) \{\s*again = true;\s*return running;/, "a sync called while one runs makes it run once more");
  need(
    "idb/wal.ts",
    /if \(through > existing\) \{\s*tx\.objectStore\(WAL_STORE\)\.delete\(IDBKeyRange\.upperBound\(existing\)\);\s*meta\.put\(through, META_INGESTED\);\s*if \(generation >= prevGen\) \{\s*meta\.put\(generation, META_GENERATION\);/,
    "advanceIngested records ingestedThrough and the generation in one transaction",
  );
  return out;
}

const drift = sourceSync();
if (drift.length > 0) {
  console.error("FAIL source sync: the model no longer matches the product");
  for (const d of drift) console.error(`  ${d}`);
  process.exit(1);
}

console.log(`bound: ${BOUNDS.appends} appends of another tab, ${BOUNDS.installs} flushes/compactions/destroys, one sync, one put and one write of the tab, messages in order or lost`);

const broken: [string, Variant][] = [
  ["a flush records ingestedThrough before its generation", { splitAdvance: true }],
  ["a stale tail's generation is installed", { installOld: true }],
  ["has counts a lower generation as held when the tail is ahead", { hasIgnoresAhead: true }],
  ["the memtable advances whatever generation is installed", { advanceAlways: true }],
  ["the memtable jumps with no gap event", { jumpNoGap: true }],
];
const t0 = performance.now();
let caught = 0;
for (const [name, v] of process.env.FORMAL_SWITCH_ONLY_CLEAN ? [] : broken) {
  const found = explore(v, BOUNDS);
  if (!found) {
    console.error(`FAIL model too weak: the broken variant "${name}" passes`);
    continue;
  }
  caught++;
  console.log(`  broken variant caught: ${name}`);
  if (process.env.FORMAL_SWITCH_SHOW) console.log(found.split("\n").map((l) => `    ${l}`).join("\n"));
}
if (!process.env.FORMAL_SWITCH_ONLY_CLEAN && caught !== broken.length) process.exit(1);

reached.clear();
const found = explore({}, BOUNDS);
const BRANCHES = [
  "the memtable jumps past seqs it never read",
  "a stale tail names a higher generation than the installed one",
  "a lower generation ahead of the memtable is installed",
  "a higher generation is installed",
  "a catch-up names a generation to load",
  "a load ends with the generation held already",
  "a load finds a file reclaimed",
  "a row of the tab lands past a gap",
  "a gap is announced",
  "a sync is called while one runs",
];
const missed = BRANCHES.filter((b) => !reached.has(b));
if (missed.length > 0) {
  console.error(`FAIL model too weak: the exploration never reached: ${missed.join("; ")}`);
  process.exit(1);
}
if (found) {
  console.error("FAIL GenSwitch");
  console.error(found);
  process.exit(1);
}
console.log(`PASS GenSwitch — ${states} states in ${Math.round(performance.now() - t0)} ms: PrefixExact, Monotone, WalGap, FeedOnce, FeedNoLoss, FeedComplete, FeedRebuild, ReadYourWrites, every call ends`);

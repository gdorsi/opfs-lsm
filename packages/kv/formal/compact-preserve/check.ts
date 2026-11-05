/**
 * Compaction merge (newest-first runs) preserves per-key visibility.
 * Mirrors pointGetSst (newest level first) and foldEntries (oldest group first).
 *
 * Sync: latestSstEntry walks levels newest-first; foldEntries applies oldest first.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Entry = { kind: "put"; value: number } | { kind: "del" } | undefined;

/** One SST run: map key → put/del. Keys are "a"|"b". */
type Run = Record<string, Entry>;

const KEYS = ["a", "b"] as const;

function layerGet(runsNewestFirst: readonly Run[], key: string): Entry {
  for (const run of runsNewestFirst) {
    const e = run[key];
    if (e !== undefined) return e;
  }
  return undefined;
}

/** foldEntries: apply oldest first so newer wins. */
function mergeCorrect(runsNewestFirst: readonly Run[]): Run {
  const out: Run = {};
  for (let i = runsNewestFirst.length - 1; i >= 0; i--) {
    Object.assign(out, runsNewestFirst[i]);
  }
  return out;
}

/** Broken: apply newest first so older wins — loses newer puts. */
function mergeBroken(runsNewestFirst: readonly Run[]): Run {
  const out: Run = {};
  for (const run of runsNewestFirst) Object.assign(out, run);
  return out;
}

function newestFirstInSource(): boolean {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const merge = fs.readFileSync(
    path.resolve(here, "../../src/store/merge.ts"),
    "utf8",
  );
  const fold = fs.readFileSync(
    path.resolve(here, "../../src/store/fold.ts"),
    "utf8",
  );
  // latestSstEntry: for (const level of levels), levels are newest-first
  // foldEntries: for (let i = groups.length - 1; i >= 0; i--)
  return (
    /function latestSstEntry[\s\S]*?for\s*\(\s*const\s+level\s+of\s+levels\s*\)/.test(merge) &&
    /for\s*\(\s*let\s+i\s*=\s*groups\.length\s*-\s*1/.test(fold)
  );
}

function mergeFn(): (runs: readonly Run[]) => Run {
  return newestFirstInSource() ? mergeCorrect : mergeBroken;
}

/** All small run lists: 0–3 runs, each key miss/put1/put2/del. */
const CELL: Entry[] = [
  undefined,
  { kind: "put", value: 1 },
  { kind: "put", value: 2 },
  { kind: "del" },
];

function* allRuns(maxRuns: number): Generator<Run[]> {
  function* rec(n: number, acc: Run[]): Generator<Run[]> {
    if (n === 0) {
      yield acc;
      return;
    }
    for (const a of CELL) {
      for (const b of CELL) {
        const run: Run = {};
        if (a !== undefined) run.a = a;
        if (b !== undefined) run.b = b;
        yield* rec(n - 1, [...acc, run]);
      }
    }
  }
  for (let n = 0; n <= maxRuns; n++) yield* rec(n, []);
}

let cases = 0;
const merge = mergeFn();

for (const runs of allRuns(2)) {
  cases++;
  const merged = merge(runs);
  for (const key of KEYS) {
    const before = layerGet(runs, key);
    const after = merged[key];
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      console.error("FAIL CompactPreserve");
      console.error(`key=${key} before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
      console.error(`runs=${JSON.stringify(runs)}`);
      console.error(
        "\nHarm: compaction / SST merge drops or resurrects a key — reads disagree before vs after compact.",
      );
      process.exit(1);
    }
  }
}

if (!newestFirstInSource()) {
  console.error(
    "FAIL CompactPreserve — merge.ts / fold.ts no longer newest-first get / oldest-first apply",
  );
  process.exit(1);
}

console.log(
  `PASS CompactPreserve — ${cases} run lists, newest-first latestSstEntry and oldest-first foldEntries`,
);

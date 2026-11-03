/**
 * Compaction merge (newest-first runs) preserves per-key visibility.
 * Mirrors SstLayer.get / mergeSsts apply order (oldest→newest so newer wins).
 *
 * Sync: SstLayer.get must walk readers newest-first; asOverlay oldest-first apply.
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

/** mergeSsts / asOverlay: apply oldest first so newer wins. */
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
  const src = fs.readFileSync(
    path.resolve(here, "../../src/store/sst-layer.ts"),
    "utf8",
  );
  // get: for (const reader of this.readers) — readers are newest-first
  // asOverlay: for (let i = this.readers.length - 1; i >= 0; i--)
  return (
    /for\s*\(\s*const\s+reader\s+of\s+this\.readers\s*\)/.test(src) &&
    /for\s*\(\s*let\s+i\s*=\s*this\.readers\.length\s*-\s*1/.test(src)
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
    "FAIL CompactPreserve — sst-layer.ts no longer newest-first get / oldest-first apply",
  );
  process.exit(1);
}

console.log(
  `PASS CompactPreserve — ${cases} run lists, newest-first merge order in sst-layer.ts`,
);

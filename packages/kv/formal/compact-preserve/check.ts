/**
 * Compaction merge (newest-first sources) preserves per-key visibility.
 * Mirrors pointGetSst (newest level first) and the merge session's pick
 * (the smallest head key; on a tie the earlier, newer source).
 *
 * Expiry: a merge judged at `judgeNow` writes a winning put expired at that
 * time as a tombstone, and drops it at the bottom. Over an older run the
 * merge did not take, every read at a time >= judgeNow (the readers' floor,
 * the manifest's judgedNow) sees the same before and after.
 *
 * Sync: latestSstEntry walks levels newest-first; the merge session and its
 * TypeScript oracle keep the earlier source on a tie (`a < b` in merge.rs,
 * `< 0` in tests/oracle/merge-ts.ts).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Entry = { kind: "put"; value: number; exp?: number } | { kind: "del" } | undefined;

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

/**
 * The merge session: each source's head is its smallest unmerged key. A
 * later source takes the pick over when `takesOver(cmp)` holds; the key goes
 * out once and every source at that key moves on.
 */
function sessionMerge(runsNewestFirst: readonly Run[], takesOver: (cmp: number) => boolean): Run {
  const heads = runsNewestFirst.map((run) => KEYS.filter((k) => run[k] !== undefined));
  const out: Run = {};
  for (;;) {
    let winner = -1;
    for (const [s, keys] of heads.entries()) {
      const key = keys[0];
      if (key !== undefined && (winner < 0 || takesOver(key.localeCompare(heads[winner]![0]!)))) winner = s;
    }
    if (winner < 0) return out;
    const key = heads[winner]![0]!;
    out[key] = runsNewestFirst[winner]![key];
    for (const keys of heads) if (keys[0] === key) keys.shift();
  }
}

/** Only a smaller key takes over, so a tie stays with the newer source. */
const mergeCorrect = (runs: readonly Run[]) => sessionMerge(runs, (cmp) => cmp < 0);

/** Broken: a tie hands the key to the older source, losing newer puts. */
const mergeBroken = (runs: readonly Run[]) => sessionMerge(runs, (cmp) => cmp <= 0);

function newestFirstInSource(): boolean {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const read = (rel: string) => fs.readFileSync(path.resolve(here, rel), "utf8");
  const merge = read("../../src/store/read.ts");
  const session = read("../../tests/oracle/merge-ts.ts");
  const engine = read("../../../../crates/engine-core/src/merge.rs");
  // latestSstEntry: for (const level of levels), levels are newest-first
  // merge-ts.ts: for (const s of this.sources) ... compareBytes(e.key, entry.key) < 0
  // merge.rs: Ordering::Equal => a < b
  return (
    /function latestSstEntry[\s\S]*?for\s*\(\s*const\s+level\s+of\s+levels\s*\)/.test(merge) &&
    /for\s*\(\s*const\s+s\s+of\s+this\.sources\s*\)\s*\{\s*const\s+e\s*=\s*s\.settled\(\);[^}]*?compareBytes\(\s*e\.key\s*,\s*entry\.key\s*\)\s*<\s*0\s*\)/.test(
      session,
    ) &&
    /Ordering::Equal\s*=>\s*a\s*<\s*b\s*,/.test(engine)
  );
}

function mergeFn(): (runs: readonly Run[]) => Run {
  return newestFirstInSource() ? mergeCorrect : mergeBroken;
}

/** All small run lists: 0–2 runs, each key miss/put1/put2/expiring put/del. */
const CELL: Entry[] = [
  undefined,
  { kind: "put", value: 1 },
  { kind: "put", value: 2 },
  { kind: "put", value: 3, exp: 1 },
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

// --- Expiry.

/** What a read at `now` returns for the newest version `e`. */
function visible(e: Entry, now: number): number | undefined {
  return e?.kind === "put" && !(e.exp !== undefined && e.exp <= now) ? e.value : undefined;
}

type Judge = (e: Entry, judgeNow: number, bottom: boolean) => Entry;

/** merge.rs `entry_at` and the drop: an expired winner is a tombstone, which the bottom drops. */
const judgeCorrect: Judge = (e, judgeNow, bottom) => {
  const out: Entry = e?.kind === "put" && e.exp !== undefined && e.exp <= judgeNow ? { kind: "del" } : e;
  return bottom && out?.kind === "del" ? undefined : out;
};
/** Broken: an expired winner is dropped above the bottom too, so the older version under it comes back. */
const judgeDropsAnywhere: Judge = (e, judgeNow, bottom) =>
  e?.kind === "put" && e.exp !== undefined && e.exp <= judgeNow ? undefined : judgeCorrect(e, judgeNow, bottom);

/** Older runs a merge leaves alone: none (a bottom merge), or one holding every key. */
const BELOW: Run[] = [{}, { a: { kind: "put", value: 9 }, b: { kind: "put", value: 9 } }];
const TIMES = [0, 1, 2];

/**
 * The first case where a read differs before and after, if any. With
 * `floor`, reads happen at judgeNow or later only, as the manifest's
 * judgedNow makes them.
 */
function expiryCounterexample(judge: Judge, floor = true): string | undefined {
  for (const runs of allRuns(2)) {
    const merged = merge(runs);
    for (const below of BELOW) {
      const bottom = Object.keys(below).length === 0;
      for (const judgeNow of TIMES) {
        const out: Run = {};
        for (const key of KEYS) {
          const e = judge(merged[key], judgeNow, bottom);
          if (e !== undefined) out[key] = e;
        }
        for (const now of TIMES.filter((t) => !floor || t >= judgeNow)) {
          for (const key of KEYS) {
            const before = visible(layerGet([...runs, below], key), now);
            const after = visible(layerGet([out, below], key), now);
            if (before !== after) {
              return `key=${key} judgeNow=${judgeNow} now=${now} before=${before} after=${after} runs=${JSON.stringify(runs)} below=${JSON.stringify(below)}`;
            }
          }
        }
        if (judge === judgeCorrect && floor) cases++;
      }
    }
  }
  return undefined;
}

const expiryBug = expiryCounterexample(judgeCorrect);
if (expiryBug) {
  console.error(`FAIL CompactPreserve (expiry): ${expiryBug}`);
  process.exit(1);
}
for (const [name, broken, floor] of [
  ["an expired put drops above the bottom", judgeDropsAnywhere, true],
  ["a reader reads below the judgedNow of the runs it reads", judgeCorrect, false],
] as const) {
  if (!expiryCounterexample(broken, floor)) {
    console.error(`FAIL CompactPreserve (expiry): broken variant not caught: ${name}`);
    process.exit(1);
  }
  console.log(`  broken variant caught: ${name}`);
}

/** merge.rs and the TypeScript session judge the winner before the drop, at the session's judgeNow. */
function judgesWinnerInSource(): boolean {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const read = (rel: string) => fs.readFileSync(path.resolve(here, rel), "utf8");
  const engine = read("../../../../crates/engine-core/src/merge.rs");
  const session = read("../../tests/oracle/merge-ts.ts");
  return (
    /let\s+entry\s*=\s*winner\.entry_at\(\s*self\.judge_now\s*\)\s*;/.test(engine) &&
    /expired\(\s*winner\s*,\s*\{\s*now:\s*this\.judgeNow\s*\}\s*\)\s*\?\s*\{\s*kind:\s*"del"/.test(session)
  );
}
if (!judgesWinnerInSource()) {
  console.error("FAIL CompactPreserve — merge.rs / tests/oracle/merge-ts.ts no longer judge the winner at judgeNow");
  process.exit(1);
}

if (!newestFirstInSource()) {
  console.error(
    "FAIL CompactPreserve — read.ts / merge.rs / tests/oracle/merge-ts.ts no longer newest-first get / newer source wins a tie",
  );
  process.exit(1);
}

console.log(
  `PASS CompactPreserve — ${cases} run lists and expiry judgments, newest-first latestSstEntry, newer-wins merge sessions, expired winners judged before the drop`,
);

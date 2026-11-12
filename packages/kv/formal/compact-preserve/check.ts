/**
 * Compaction merge (newest-first sources) preserves per-key visibility.
 * Mirrors pointGetSst (newest level first) and the merge session's pick
 * (the smallest head key; on a tie the earlier, newer source).
 *
 * Range deletes: a merge drops a winner the base manifest's marks cover,
 * and its output claims the base manifest's marks only. Every reader at or
 * past the install, whose marks join the base's and any later ones and
 * retire what no run can still hold, reads what it read before.
 *
 * Sync: latestSstEntry walks levels newest-first; the merge session and its
 * TypeScript oracle keep the earlier source on a tie (`a < b` in merge.rs,
 * `< 0` in tests/oracle/merge-ts.ts).
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

// --- Range deletes.
//
// One key, three versions: two merge inputs and an older run the merge does
// not take, seqs 1 (below) to 3 (newest). The base manifest's `through` is 3
// and its mark covers seqs up to `base`. A flush between the merge and its
// install adds a later mark (at 4) covering seqs up to `late`. The merge
// drops a winner its base mark covers; its output claims `marksThrough`; the
// install joins both marks and retires the piece once every run holding the
// key claims its `at`. Every read at or past the install must agree with a
// read of the inputs under both marks. Per-key pieces retire at least as
// eagerly as key ranges, which overlap more runs.

type Held = { readonly v: Entry; readonly seq: number; readonly marksThrough: number };

const BASE_THROUGH = 3;
const LATE_AT = 4;
const VERSIONS: Entry[] = [undefined, { kind: "put", value: 1 }, { kind: "del" }];

/** A read under a mark of `through` (0: none): the newest version, unless it is a delete or covered. */
function readUnder(runs: readonly Held[], through: number): number | undefined {
  const newest = runs.find((r) => r.v !== undefined);
  return newest?.v?.kind === "put" && newest.seq > through ? newest.v.value : undefined;
}

type MergeRule = (winner: Held, base: number, bottom: boolean) => Entry;

/** merge.rs `next_key`: a winner the base mark covers is gone; a delete drops at the bottom. */
const markCorrect: MergeRule = (w, base, bottom) => (w.seq <= base ? undefined : bottom && w.v?.kind === "del" ? undefined : w.v);
/** Broken: covers one seq past the mark, so a live winner is dropped and the older version comes back. */
const markOneTooHigh: MergeRule = (w, base, bottom) => (w.seq <= base + 1 ? undefined : markCorrect(w, base, bottom));

function marksCounterexample(rule: MergeRule, claim: number): string | undefined {
  for (const v0 of VERSIONS) {
    for (const v1 of VERSIONS) {
      for (const vb of VERSIONS) {
        for (const base of [0, 1, 2]) {
          for (const late of [0, 1, 2, 3]) {
            for (const belowThrough of [0, BASE_THROUGH]) {
              // A run that claims the base mark holds no version it covers.
              if (belowThrough >= BASE_THROUGH && vb !== undefined && base >= 1) continue;
              const inputs: Held[] = [
                { v: v0, seq: 3, marksThrough: 0 },
                { v: v1, seq: 2, marksThrough: 0 },
              ];
              const below: Held = { v: vb, seq: 1, marksThrough: belowThrough };
              const winner = inputs.find((r) => r.v !== undefined);
              const out = winner && { v: rule(winner, base, vb === undefined), seq: winner.seq, marksThrough: claim };
              // join: the larger through wins, with its at.
              const piece = late > base ? { through: late, at: LATE_AT } : { through: base, at: base > 0 ? BASE_THROUGH : 0 };
              const after = [...(out?.v ? [out] : []), below];
              const blocked = after.some((r) => r.v !== undefined && r.marksThrough < piece.at);
              const retired = blocked ? piece.through : 0;
              const before = readUnder([...inputs, below], piece.through);
              const got = readUnder(after, retired);
              if (before !== got) {
                return `versions=${JSON.stringify([v0, v1, vb])} base=${base} late=${late} below.marksThrough=${belowThrough} before=${before} after=${got}`;
              }
              if (rule === markCorrect && claim === BASE_THROUGH) cases++;
            }
          }
        }
      }
    }
  }
  return undefined;
}

const marksBug = marksCounterexample(markCorrect, BASE_THROUGH);
if (marksBug) {
  console.error(`FAIL CompactPreserve (range deletes): ${marksBug}`);
  process.exit(1);
}
for (const [name, rule, claim] of [
  ["a merge drops a winner one seq past its mark", markOneTooHigh, BASE_THROUGH],
  ["an output claims a mark the merge never saw", markCorrect, LATE_AT],
] as const) {
  if (!marksCounterexample(rule, claim)) {
    console.error(`FAIL CompactPreserve (range deletes): broken variant not caught: ${name}`);
    process.exit(1);
  }
  console.log(`  broken variant caught: ${name}`);
}

/** Both merge sessions drop a covered winner before anything else, and an output claims the base manifest's through. */
function appliesMarksInSource(): boolean {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const read = (rel: string) => fs.readFileSync(path.resolve(here, rel), "utf8");
  const engine = read("../../../../crates/engine-core/src/merge.rs");
  const session = read("../../tests/oracle/merge-ts.ts");
  const compact = read("../../src/host/compact.ts");
  return (
    /if\s+self\.through\s*>\s*0\s*&&\s*winner\.seq\s*<=\s*self\.through\s*\{\s*self\.retire\(w\);\s*return\s+Ok\(\(\)\);\s*\}\s*match\s+winner\.kind/.test(engine) &&
    /private\s+emit\(e:\s*SstEntry\):\s*void\s*\{\s*if\s*\(\s*covered\(\s*this\.marks\s*,\s*e\.key\s*,\s*e\.seq\s*\)\s*\)\s*return;/.test(session) &&
    /marksThrough:\s*base\.through\s*\}/.test(compact)
  );
}
if (!appliesMarksInSource()) {
  console.error("FAIL CompactPreserve — merge.rs / merge-ts.ts / compact.ts no longer drop a covered winner first and claim base.through");
  process.exit(1);
}

if (!newestFirstInSource()) {
  console.error(
    "FAIL CompactPreserve — read.ts / merge.rs / tests/oracle/merge-ts.ts no longer newest-first get / newer source wins a tie",
  );
  process.exit(1);
}

console.log(
  `PASS CompactPreserve — ${cases} run lists and range delete layouts, newest-first latestSstEntry, newer-wins merge sessions, covered winners dropped and only the base marks claimed`,
);

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { RunMeta } from "../src/store/generation.js";
import { planCompaction, replaceRuns } from "../src/store/levels.js";
import { covered, joinMarks, markTable, NO_MARKS, retireMarks, type Marks } from "../src/store/marks.js";
import { coveredBytes, deadBytes, expiredBytes } from "../src/store/run-stats.js";
import { decodeSst, encodeRun, type SstEntry } from "../src/store/sst.js";
import { listed, mergeRuns } from "./runs.js";

/**
 * The planner driven with the real merge until it returns nothing, on
 * layouts flushed from generated histories: the steps end, and the runs
 * left read as the history says.
 */

const enc = new TextEncoder();
const KEYS = Array.from({ length: 12 }, (_, i) => enc.encode(`k${String(i).padStart(2, "0")}`));
/** Small, so a few flushes fill several levels and a merge cuts several runs. */
const L1_TARGET = 600;
const OUTPUT_BYTES = 400;
const MAX_STEPS = 300;

type Op =
  | { readonly kind: "put"; readonly key: number; readonly size: number; readonly expiresAt?: number }
  | { readonly kind: "del"; readonly key: number }
  | { readonly kind: "deleteRange"; readonly start: number; readonly end: number; readonly back: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ kind: fc.constant("put" as const), key: fc.nat(11), size: fc.integer({ min: 0, max: 60 }) }) },
  {
    weight: 3,
    arbitrary: fc.record({ kind: fc.constant("put" as const), key: fc.nat(11), size: fc.integer({ min: 0, max: 60 }), expiresAt: fc.integer({ min: 1, max: 200 }) }),
  },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("del" as const), key: fc.nat(11) }) },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant("deleteRange" as const), start: fc.nat(11), end: fc.integer({ min: 1, max: 12 }), back: fc.nat(10) }),
  },
);
const historyArb = fc.array(fc.array(opArb, { minLength: 1, maxLength: 10 }), { minLength: 1, maxLength: 14 });

type Layout = { runs: RunMeta[]; marks: Marks; through: number; bodies: Map<string, Uint8Array>; log: SstEntry[] };

/** Each batch is one flush into L0 with seqs of its own; a range delete is a batch of its own. */
function flush(history: readonly (readonly Op[])[]): Layout {
  const layout: Layout = { runs: [], marks: NO_MARKS, through: 0, bodies: new Map(), log: [] };
  const write = (entries: SstEntry[]) => {
    if (entries.length === 0) return;
    const { body, end } = encodeRun(entries);
    const path = `l0/${layout.through}.sst`;
    layout.bodies.set(path, body);
    // A flush absorbs every mark before it: none covers a seq this new.
    layout.runs.unshift(listed(path, end, layout.through));
  };
  for (const batch of history) {
    let entries = new Map<number, SstEntry>();
    for (const op of batch) {
      if (op.kind === "deleteRange") {
        write([...entries.values()]);
        entries = new Map();
        const seq = ++layout.through;
        const end = Math.max(op.end, op.start + 1);
        const mark = {
          start: KEYS[op.start]!,
          ...(end < KEYS.length ? { endExclusive: KEYS[end]! } : {}),
          through: Math.max(0, seq - 1 - op.back),
          at: seq,
        };
        layout.marks = joinMarks(layout.marks, markTable(mark));
        continue;
      }
      const seq = ++layout.through;
      const key = KEYS[op.key]!;
      const entry: SstEntry =
        op.kind === "del"
          ? { kind: "del", key, seq }
          : { kind: "put", key, value: new Uint8Array(op.size).fill(97), seq, ...(op.expiresAt === undefined ? {} : { expiresAt: op.expiresAt }) };
      entries.set(op.key, entry);
      layout.log.push(entry);
    }
    write([...entries.values()]);
  }
  layout.marks = retireMarks(layout.marks, layout.runs);
  return layout;
}

/** What a read at `now` finds: the newest version of each key, unless a mark covers it, it is a tombstone, or it expired. */
function readable(entries: readonly SstEntry[], marks: Marks, now: number): string[] {
  const newest = new Map<string, SstEntry>();
  for (const e of entries) {
    const k = String.fromCharCode(...e.key);
    if ((newest.get(k)?.seq ?? -1) < e.seq) newest.set(k, e);
  }
  return [...newest.values()]
    .filter((e) => e.kind === "put" && !covered(marks, e.key, e.seq) && !(e.expiresAt !== undefined && e.expiresAt <= now))
    .map((e) => `${String.fromCharCode(...e.key)}@${e.seq}`)
    .sort();
}

async function compactUntilDone(layout: Layout, now: number): Promise<number> {
  for (let step = 0; ; step++) {
    const plan = planCompaction(layout, now, { maxSources: 8, l1Target: L1_TARGET });
    if (!plan) return step;
    if (step >= MAX_STEPS) throw new Error(`no end after ${MAX_STEPS} steps`);
    let outputs: RunMeta[] = [];
    if (plan.kind === "merge") {
      const { runs } = await mergeRuns(
        plan.sources.map((source) => source.map((r) => layout.bodies.get(r.path)!)),
        { dropTombstones: plan.bottom, judgeNow: now, marks: layout.marks, targetBytes: OUTPUT_BYTES },
      );
      outputs = runs.map(({ body, end }, i) => {
        const path = `l${plan.outputLevel}/s${step}.${i}.sst`;
        layout.bodies.set(path, body);
        return listed(path, end, layout.through);
      });
    }
    layout.runs = replaceRuns(layout.runs, plan.inputs.map((r) => r.path), outputs);
    layout.marks = retireMarks(layout.marks, layout.runs);
  }
}

describe("compaction on generated histories", () => {
  it("runs until the planner returns nothing, and every read agrees with the history", async () => {
    await fc.assert(
      fc.asyncProperty(historyArb, fc.integer({ min: 0, max: 220 }), async (history, now) => {
        const layout = flush(history);
        const want = readable(layout.log, layout.marks, now);
        await compactUntilDone(layout, now);
        const left = layout.runs.flatMap((r) => decodeSst(layout.bodies.get(r.path)!));
        expect(readable(left, layout.marks, now)).toEqual(want);
        expect(layout.marks.empty, "every mark retired").toBe(true);
        for (const run of layout.runs) {
          // An L0 run's tombstones wait for the L0 step.
          const dead = run.path.startsWith("l0/") ? expiredBytes(run.stats, now) + coveredBytes(run, layout.marks) : deadBytes(run, layout.marks, now);
          expect(dead, `${run.path} still has dead bytes`).toBeLessThan(run.stats.entryBytes / 2);
        }
      }),
      { numRuns: 300 },
    );
  });
});

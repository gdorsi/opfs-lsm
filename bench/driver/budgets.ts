/**
 * Upper bounds on the bytes kv writes and keeps, checked on every run that
 * records the row. Byte counters barely move between runs of one commit, so a
 * budget a little above today's value catches a regression that timings on a
 * shared CI runner cannot. `bench:smoke --check` also runs the rows above
 * size `tiny`, where compaction does most of the writing.
 *
 * To raise a budget, state in the commit what made the engine write more.
 */
import { DEFAULT_SEED, type SizeName } from "../core/types.ts";
import type { Measures } from "./metrics.ts";

export type Budget = {
  readonly workload: string;
  readonly contender: string;
  readonly size: SizeName;
  readonly phase: string;
  readonly metric: "amp:wampTotal" | "amp:spaceAmp";
  /** A run above this fails. */
  readonly max: number;
};

export const BUDGETS: readonly Budget[] = [
  { workload: "kv/fillrandom", contender: "kv/kv", size: "tiny", phase: "settle", metric: "amp:wampTotal", max: 2.1 },
  { workload: "kv/fillrandom", contender: "kv/kv", size: "tiny", phase: "settle", metric: "amp:spaceAmp", max: 1.05 },
  { workload: "kv/fillrandom", contender: "kv/kv", size: "tiny", phase: "settle-deleted", metric: "amp:spaceAmp", max: 1.2 },
  { workload: "kv/fillseq", contender: "kv/kv", size: "tiny", phase: "settle", metric: "amp:wampTotal", max: 2.2 },
  { workload: "kv/ycsb-a", contender: "kv/kv", size: "tiny", phase: "settle-after", metric: "amp:wampTotal", max: 1.9 },
  { workload: "kv/ycsb-a", contender: "kv/kv", size: "tiny", phase: "settle-after", metric: "amp:spaceAmp", max: 1.5 },
  { workload: "tanstack/todos", contender: "tanstack/kv", size: "tiny", phase: "check-after", metric: "amp:wampTotal", max: 2.5 },
  { workload: "tanstack/todos", contender: "tanstack/kv", size: "tiny", phase: "check-after", metric: "amp:spaceAmp", max: 1.5 },
  { workload: "tracker/goals", contender: "tracker/docstore", size: "tiny", phase: "settle", metric: "amp:wampTotal", max: 4.6 },
  { workload: "tracker/goals", contender: "tracker/docstore", size: "tiny", phase: "settle", metric: "amp:spaceAmp", max: 2.7 },
  { workload: "kv/fillrandom", contender: "kv/kv", size: "small", phase: "settle", metric: "amp:wampTotal", max: 3.9 },
  { workload: "kv/fillrandom", contender: "kv/kv", size: "small", phase: "settle", metric: "amp:spaceAmp", max: 1.05 },
];

/**
 * One line per budget a run broke. A budget whose workload, contender and
 * size ran but whose number is missing is a problem too, so a renamed phase
 * cannot switch a budget off. A budget whose row did not run is skipped. The
 * budgets hold for kv's default options and the default seed, so a run that
 * changed either is not checked.
 */
export function budgetProblems(m: Measures, budgets: readonly Budget[] = BUDGETS): string[] {
  if (m.kvOptions.length > 0 || m.seeds.some((s) => s !== DEFAULT_SEED)) return [];
  const problems: string[] = [];
  for (const b of budgets) {
    const { max, ...at } = b;
    const where = `${b.workload} ${b.contender} ${b.size} ${b.phase} ${b.metric}`;
    const series = m.get(at);
    if (!series) {
      const ran = m.all.some((s) => s.at.workload === b.workload && s.at.contender === b.contender && s.at.size === b.size);
      if (ran) problems.push(`${where}: the run recorded no such number, so its budget of ${max} checks nothing`);
    } else if (series.summary.max > max) {
      problems.push(`${where}: ${series.summary.max.toFixed(3)} is over the budget of ${max}`);
    }
  }
  return problems;
}

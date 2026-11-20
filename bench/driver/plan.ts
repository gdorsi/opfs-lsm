/**
 * Pure: catalog × selection → an interleaved run list. Reps are the outer
 * loop and the contender order rotates each rep (A B C, B C A, C A B), then
 * the next n reps run the rotations reversed (C B A, A C B, B A C), so
 * warmup, thermal drift and background noise favor no contender and no
 * contender always follows the same other one. Three contenders over six
 * reps run all six orders.
 */
import type { Catalog, PageMode, SizeName } from "../core/types.ts";

export type PlannedRun = {
  readonly workload: string;
  readonly contender: string;
  readonly size: SizeName;
  readonly rep: number;
  readonly seed: number;
  readonly phases: readonly { readonly page: PageMode; readonly rounds: number }[];
};

export type Selection = {
  /** "kv/" selects a family, "kv/fillrandom" one workload. Empty = everything. */
  readonly workloads: readonly string[];
  /** Contender ids or bare names ("idb" matches "kv/idb"). Empty = all of the family. */
  readonly contenders: readonly string[];
  readonly size: SizeName;
  readonly reps: number;
  readonly seed: number;
};

export function plan(catalog: Catalog, sel: Selection): PlannedRun[] {
  const picked = catalog.filter(
    (w) => sel.workloads.length === 0 || sel.workloads.some((s) => (s.endsWith("/") ? w.workload.startsWith(s) : w.workload === s)),
  );
  if (picked.length === 0) throw new Error(`no workload matches ${sel.workloads.join(" ")}`);
  const runs: PlannedRun[] = [];
  for (let rep = 0; rep < sel.reps; rep++) {
    for (const w of picked) {
      const contenders = w.contenders.filter(
        (c) => sel.contenders.length === 0 || sel.contenders.some((s) => c === s || c.endsWith(`/${s}`)),
      );
      const n = contenders.length;
      const reversed = Math.floor(rep / n) % 2 === 1;
      for (let i = 0; i < n; i++) {
        const contender = contenders[((reversed ? n - 1 - i : i) + rep) % n]!;
        runs.push({ workload: w.workload, contender, size: sel.size, rep, seed: sel.seed, phases: w.phases.map(({ page, rounds }) => ({ page, rounds })) });
      }
    }
  }
  if (runs.length === 0) throw new Error(`no contender matches ${sel.contenders.join(" ")}`);
  return runs;
}

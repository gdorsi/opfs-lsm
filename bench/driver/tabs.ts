/**
 * Pure: the tab each round of each phase runs in. A run has at most two tabs.
 * A fresh page is always tab 0, and "other" is the tab the previous phase did
 * not use.
 */
import type { PageMode } from "../core/types.ts";

export type TabSlot = 0 | 1;

export type TabStep = {
  readonly phase: number;
  readonly round: number;
  /** Close every tab and wait for the SharedWorkers to exit before this step, or "cold" is warm. */
  readonly fresh: boolean;
  readonly slot: TabSlot;
};

export function tabPlan(phases: readonly { readonly page: PageMode; readonly rounds: number }[]): TabStep[] {
  const steps: TabStep[] = [];
  let slot: TabSlot = 0;
  phases.forEach(({ page, rounds }, phase) => {
    for (let round = 0; round < rounds; round++) {
      const fresh = round > 0 || (page === "fresh" && phase > 0);
      slot = page === "fresh" ? 0 : page === "other" ? (slot === 0 ? 1 : 0) : slot;
      steps.push({ phase, round, fresh, slot });
    }
  });
  return steps;
}

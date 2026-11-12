import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPACTION_MEMORY_BYTES,
  hostBudget,
  MIN_COMPACTION_MEMORY_BYTES,
  type HostBudget,
} from "../src/host/budget.js";

const KiB = 1024;
const MiB = 1024 * KiB;

describe("hostBudget", () => {
  it("is the swept configuration at the default budget", () => {
    expect(DEFAULT_COMPACTION_MEMORY_BYTES).toBe(32 * MiB);
    expect(hostBudget(DEFAULT_COMPACTION_MEMORY_BYTES)).toEqual({
      chunkBytes: 128 * KiB,
      tailBytes: 128 * KiB,
      maxSources: 49,
      flushRunBytes: 1.75 * MiB,
      l0StopRuns: 48,
      yieldBytes: 1 * MiB,
      wasmRecycleBytes: 16 * MiB,
      l1TargetBytes: 40 * MiB,
    });
  });

  it.each<[number, HostBudget]>([
    [
      8 * MiB,
      {
        chunkBytes: 64 * KiB,
        tailBytes: 64 * KiB,
        maxSources: 18,
        flushRunBytes: 0.4375 * MiB,
        l0StopRuns: 17,
        yieldBytes: 1 * MiB,
        wasmRecycleBytes: 4 * MiB,
        l1TargetBytes: 40 * MiB,
      },
    ],
    [
      16 * MiB,
      {
        chunkBytes: 64 * KiB,
        tailBytes: 64 * KiB,
        maxSources: 44,
        flushRunBytes: 0.875 * MiB,
        l0StopRuns: 43,
        yieldBytes: 1 * MiB,
        wasmRecycleBytes: 8 * MiB,
        l1TargetBytes: 40 * MiB,
      },
    ],
    [
      64 * MiB,
      {
        chunkBytes: 256 * KiB,
        tailBytes: 128 * KiB,
        maxSources: 49,
        flushRunBytes: 3.5 * MiB,
        l0StopRuns: 48,
        yieldBytes: 1 * MiB,
        wasmRecycleBytes: 32 * MiB,
        l1TargetBytes: 40 * MiB,
      },
    ],
  ])("shrinks and grows with the budget: %i bytes", (budget, expected) => {
    expect(hostBudget(budget)).toEqual(expected);
  });

  it("grows nothing but the recycle threshold past 64 MiB", () => {
    const { wasmRecycleBytes, ...at64 } = hostBudget(64 * MiB);
    const { wasmRecycleBytes: recycle512, ...at512 } = hostBudget(512 * MiB);
    expect(at512).toEqual(at64);
    expect(recycle512).toBe(256 * MiB);
    expect(wasmRecycleBytes).toBe(32 * MiB);
    expect(hostBudget(Number.POSITIVE_INFINITY)).toMatchObject({ ...at64, wasmRecycleBytes: Number.POSITIVE_INFINITY });
  });

  it("reads a budget below the minimum as the minimum", () => {
    expect(MIN_COMPACTION_MEMORY_BYTES).toBe(8 * MiB);
    expect(hostBudget(1)).toEqual(hostBudget(MIN_COMPACTION_MEMORY_BYTES));
    expect(hostBudget(-5 * MiB)).toEqual(hostBudget(MIN_COMPACTION_MEMORY_BYTES));
  });

  it("stops L0 one run short of the sources a step reads, at every budget", () => {
    for (let mib = 8; mib <= 128; mib++) {
      const budget = hostBudget(mib * MiB);
      expect(budget.l0StopRuns).toBe(budget.maxSources - 1);
    }
  });

  it("never gives a merge a tail longer than its window", () => {
    for (let mib = 8; mib <= 128; mib++) {
      const budget = hostBudget(mib * MiB);
      expect(budget.tailBytes).toBeLessThanOrEqual(budget.chunkBytes);
    }
  });

  it("keeps every figure within a range the engine and the planner accept", () => {
    for (let mib = 8; mib <= 128; mib++) {
      const budget = hostBudget(mib * MiB);
      expect(budget.chunkBytes).toBeGreaterThanOrEqual(64 * KiB);
      expect(budget.chunkBytes).toBeLessThanOrEqual(256 * KiB);
      expect(budget.chunkBytes % (32 * KiB)).toBe(0);
      expect(budget.maxSources).toBeGreaterThanOrEqual(18);
      expect(budget.maxSources).toBeLessThanOrEqual(49);
      expect(budget.flushRunBytes).toBeGreaterThan(0);
      expect(budget.flushRunBytes).toBeLessThanOrEqual(4 * MiB);
      expect(Number.isInteger(budget.flushRunBytes)).toBe(true);
    }
  });

  it("never lowers a figure when the budget grows", () => {
    let last = hostBudget(8 * MiB);
    for (let mib = 9; mib <= 128; mib++) {
      const budget = hostBudget(mib * MiB);
      for (const key of Object.keys(budget) as (keyof HostBudget)[]) {
        expect(budget[key], `${key} at ${mib} MiB`).toBeGreaterThanOrEqual(last[key]);
      }
      last = budget;
    }
  });
});

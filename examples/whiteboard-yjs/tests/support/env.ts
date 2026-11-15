import type { Env } from "../../src/model/types.ts";

export type TestEnv = Env & {
  /** Moves the clock forward and runs every timer that comes due, in order. Then lets pending promises settle. */
  advance(ms: number): Promise<void>;
  /** Lets pending promises settle without moving the clock. */
  settle(): Promise<void>;
  /** Timers that have been scheduled and not yet run or cancelled. */
  pending(): number;
};

/** Ids, a clock and timers that only move when the test says so. No real timer anywhere. */
export function testEnv(id: () => string = idCounter("n"), start = 1_700_000_000_000): TestEnv {
  let time = start;
  const timers = new Set<{ at: number; fn: () => void }>();
  const settle = async () => {
    for (let i = 0; i < 25; i++) await Promise.resolve();
  };
  return {
    id,
    now: () => time,
    schedule(fn, ms) {
      const timer = { at: time + ms, fn };
      timers.add(timer);
      return () => void timers.delete(timer);
    },
    async advance(ms) {
      const target = time + ms;
      for (;;) {
        const next = [...timers].filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        timers.delete(next);
        time = Math.max(time, next.at);
        next.fn();
        await settle();
      }
      time = target;
      await settle();
    },
    settle,
    pending: () => timers.size,
  };
}

export function idCounter(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}${++n}`;
}

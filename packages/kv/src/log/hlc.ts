import type { Stamp } from "./frame.js";

/**
 * Counter values per microsecond. A burst past it borrows from the next
 * microsecond. Microseconds since 2025 × 4 stay below 2^53 until 2096.
 */
const PER_US = 4;
const EPOCH_MS = Date.UTC(2025, 0, 1);

/** Wall-clock microseconds since 2025; every tab of the origin reads the same clock. */
function wallUs(): number {
  return Math.floor((performance.timeOrigin + performance.now() - EPOCH_MS) * 1000);
}

/**
 * A hybrid logical clock. Stamps rise with the shared wall clock, never
 * repeat, and are above every stamp this tab has seen, so a write made after
 * reading another tab's write sorts after it. Writes of different tabs that
 * did not see each other sort by wall-clock time, to the clock's resolution
 * (performance.now() is coarsened to 5–100 µs in browsers), then by tab id.
 */
export class Hlc {
  private top = 0;

  constructor(private readonly clock: () => number = wallUs) {}

  /** The highest stamp issued or observed. No later stamp is at or below it. */
  get last(): Stamp {
    return this.top;
  }

  next(): Stamp {
    this.top = Math.max(this.clock() * PER_US, this.top + 1);
    return this.top;
  }

  observe(stamp: Stamp): void {
    if (stamp > this.top) this.top = stamp;
  }
}

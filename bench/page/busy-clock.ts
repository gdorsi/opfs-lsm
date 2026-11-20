/**
 * Time with at least one timed call in flight: the union of the calls'
 * intervals, so nested or concurrent calls count once and the gaps between
 * calls (the harness) not at all.
 */
export class BusyClock {
  private inFlight = 0;
  private since = 0;
  private total = 0;

  private readonly now: () => number;

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }

  /** A call starts. Returns its start time. */
  enter(): number {
    const t = this.now();
    if (this.inFlight++ === 0) this.since = t;
    return t;
  }

  /** A call ends. Returns its end time. */
  exit(): number {
    const t = this.now();
    if (--this.inFlight === 0) this.total += t - this.since;
    return t;
  }

  get ms(): number {
    return this.total;
  }
}

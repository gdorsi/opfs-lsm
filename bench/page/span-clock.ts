/**
 * From the start of the first timed call to the end of the last one. The gaps
 * between calls count: a store that works in the background while the harness
 * builds the next call is not credited for it.
 */
export class SpanClock {
  private first: number | undefined;
  private last = 0;

  private readonly now: () => number;

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }

  /** A call starts. Returns its start time. */
  enter(): number {
    const t = this.now();
    this.first ??= t;
    return t;
  }

  /** A call ends. Returns its end time. */
  exit(): number {
    const t = this.now();
    this.last = Math.max(this.last, t);
    return t;
  }

  get ms(): number {
    return this.first === undefined ? 0 : this.last - this.first;
  }
}

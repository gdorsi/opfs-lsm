/**
 * The time this context judges expiry at, epoch ms. It never goes back: a
 * reading is at least every earlier one and at least the `floor` the caller
 * passes, the installed manifest's `judgedNow`, below which the manifest's
 * runs already judged every put.
 */
export class WallClock {
  private last = 0;

  constructor(private readonly read: () => number = Date.now) {}

  now(floor = 0): number {
    const t = Math.max(this.last, this.read(), floor);
    this.last = t;
    return t;
  }
}

/** The clock of every handle in this context that was not given one. */
export const contextClock = new WallClock();

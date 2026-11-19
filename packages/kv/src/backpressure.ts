const DEFAULT_MEMTABLE_BYTES = 16 * 1024 * 1024;

/** Below this, one batch may not fit. */
const MIN_MEMTABLE_BYTES = 1024 * 1024;

/** The two thresholds on `Memtable.bytes`. */
export type MemtableCaps = {
  /** Past this, the tab asks the host for a flush and goes on writing. */
  readonly soft: number;
  /** At this, a write waits for that flush. */
  readonly hard: number;
};

/**
 * 7/8 and 1x, the split RocksDB's write buffer manager makes between starting
 * a flush and stalling writes. The flush has the last eighth to finish in.
 */
export function memtableCaps(requested = DEFAULT_MEMTABLE_BYTES): MemtableCaps {
  const hard = Math.max(MIN_MEMTABLE_BYTES, requested);
  return { soft: Math.floor((hard * 7) / 8), hard };
}

/**
 * Keeps a tab's memtable near its caps by tying writes to the host's flushes.
 * At most one flush is in flight, and a write that has to wait waits on the
 * flush the soft cap already asked for. `askAt` is the size at which the tab
 * asks next: the soft cap, or after a flush that did not help, one eighth of
 * the budget past where it ended.
 */
export class Backpressure {
  private askAt: number;
  /** The flush in flight, if any. */
  private flushing: Promise<boolean> | undefined;

  /**
   * `flush` asks the host to flush the WAL and loads what it published. It
   * resolves true when that moved the tab to a newer generation.
   */
  constructor(
    private readonly caps: MemtableCaps,
    private readonly bytes: () => number,
    private readonly flush: () => Promise<boolean>,
  ) {
    this.askAt = caps.soft;
  }

  /** A write joined the memtable. Past the soft cap, ask for a flush and do not wait for it. */
  landed(): void {
    if (!this.flushing && this.bytes() >= this.askAt) this.start();
  }

  /** True at the hard cap. A write that finds room should not call `admit`: it would yield first. */
  get full(): boolean {
    return this.bytes() >= this.caps.hard;
  }

  /**
   * Before a write. At the hard cap, wait for the flush in flight, or start
   * one, and look again. After a flush that failed or left the generation
   * where it was, writes go on until the table has grown an eighth of the
   * limit more, so a host that cannot help neither stops writes nor is asked
   * on every one.
   */
  async admit(): Promise<void> {
    while (this.full) {
      if (!this.flushing && this.bytes() < this.askAt) return;
      await (this.flushing ?? this.start());
    }
  }

  private start(): Promise<boolean> {
    const finish = (advanced: boolean): boolean => {
      this.flushing = undefined;
      this.askAt = advanced ? this.caps.soft : this.bytes() + (this.caps.hard - this.caps.soft);
      return advanced;
    };
    this.flushing = this.flush().then(finish, () => finish(false));
    return this.flushing;
  }
}

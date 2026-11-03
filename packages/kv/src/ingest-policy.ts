/** When to fold the shared IDB WAL into OPFS (visibility is already at IDB ack). */
export type IngestPolicy = {
  /** Flush after this many WAL batches since last successful ingest schedule. */
  readonly maxBatches: number;
  /** Flush after this many encoded op bytes (keys+values) since last schedule. */
  readonly maxBytes: number;
  /** Debounce: flush at most this long after the first pending batch. */
  readonly maxDelayMs: number;
};

export const DEFAULT_INGEST_POLICY: IngestPolicy = {
  maxBatches: 32,
  maxBytes: 256 * 1024,
  maxDelayMs: 50,
};

export class IngestScheduler<T> {
  private batches = 0;
  private bytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly policy: IngestPolicy,
    private readonly run: () => Promise<T>,
  ) {}

  /** Record a committed WAL batch; may schedule background ingest (not awaited). */
  noteAppend(opBytes: number): void {
    this.batches += 1;
    this.bytes += opBytes;
    if (
      this.batches >= this.policy.maxBatches ||
      this.bytes >= this.policy.maxBytes
    ) {
      this.arm(0);
      return;
    }
    this.arm(this.policy.maxDelayMs);
  }

  /** Explicit ingest (awaits). */
  async flush(): Promise<T> {
    this.arm(0);
    return this.chain as Promise<T>;
  }

  close(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(delayMs: number): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const start = (): void => {
      this.batches = 0;
      this.bytes = 0;
      this.chain = this.chain.catch(() => undefined).then(() => this.run());
    };
    if (delayMs <= 0) {
      start();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      start();
    }, delayMs);
  }
}

export function measureOpBytes(
  ops: readonly { key: Uint8Array; value?: Uint8Array }[],
): number {
  let n = 0;
  for (const op of ops) {
    n += op.key.byteLength;
    if (op.value) n += op.value.byteLength;
  }
  return n;
}

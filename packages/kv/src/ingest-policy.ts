/**
 * When to flush the memtable into an L0 run. Every tab holds the whole
 * memtable, so every tab sees the record that crosses a limit and asks the
 * ingest host to flush through it. The host flushes once.
 */
export type IngestPolicy = {
  /** Flush once this many WAL records are waiting. Bounds the WAL when writes overwrite a few keys. */
  readonly maxBatches: number;
  /** Flush once the memtable's key and value bytes reach this. */
  readonly maxBytes: number;
};

export const DEFAULT_INGEST_POLICY: IngestPolicy = {
  maxBatches: 10_000,
  maxBytes: 4 * 1024 * 1024,
};

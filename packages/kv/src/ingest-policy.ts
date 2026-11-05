/**
 * When to flush the WAL into an L0 run. Every tab applies every WAL record,
 * so every tab sees the record that takes the WAL past the limit and asks
 * the ingest host to flush through it. The host flushes once.
 */
export type IngestPolicy = {
  /**
   * Flush once the WAL records waiting for ingest hold this many key and
   * value bytes. It counts every op as written, so overwrites and deletes
   * bound the WAL as much as new keys do, whatever the batch sizes.
   */
  readonly maxWalBytes: number;
};

export const DEFAULT_INGEST_POLICY: IngestPolicy = {
  maxWalBytes: 4 * 1024 * 1024,
};

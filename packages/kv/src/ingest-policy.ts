/**
 * When to flush the WAL into an L0 run. The ingest host counts the appends
 * tabs announce, and measures the WAL whenever a tab opens the database, so
 * ingest does not depend on any tab staying open or responsive. When tabs
 * pass different limits, the host uses the smallest.
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

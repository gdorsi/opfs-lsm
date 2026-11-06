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

/**
 * Every openDb replays the whole uningested WAL on the tab's main thread, at
 * a cost per row. 1 MiB keeps that replay near 40 ms with ~100-byte ops
 * (yjs bench: 4 MiB opened in 71-91 ms, 1 MiB in 39-44 ms, 256 KiB in
 * 25-39 ms). Lower limits mean more ingests and L0 compactions for little
 * more open time saved.
 */
export const DEFAULT_INGEST_POLICY: IngestPolicy = {
  maxWalBytes: 1024 * 1024,
};

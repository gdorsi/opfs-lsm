/**
 * When to fold the logs into an L0 run. Each tab counts the bytes of the
 * stable records above the installed generation's cut and asks the ingest
 * host for an ingest once they pass its limit, so the smallest limit of any
 * open tab wins.
 */
export type IngestPolicy = {
  /**
   * Ask for an ingest once the stable log records above the cut hold this
   * many key and value bytes. It counts every op as written, so overwrites
   * and deletes bound the logs as much as new keys do, whatever the batch
   * sizes. Also the size at which a tab seals a log segment.
   */
  readonly maxWalBytes: number;
};

/**
 * Every openDb decodes the log records above the cut on the tab's main
 * thread, at a cost per row. 1 MiB kept that replay near 40 ms with
 * ~100-byte ops (measured on Yjs docs with the earlier IndexedDB log:
 * 4 MiB opened in 71-91 ms, 1 MiB in 39-44 ms, 256 KiB in 25-39 ms). Lower
 * limits mean more ingests and L0 compactions for little more open time
 * saved.
 */
export const DEFAULT_INGEST_POLICY: IngestPolicy = {
  maxWalBytes: 1024 * 1024,
};

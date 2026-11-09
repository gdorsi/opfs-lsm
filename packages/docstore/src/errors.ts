/**
 * Every error this package throws on purpose. Callers branch on `code`.
 * kv's own errors (ConstraintError over kv's batch limits, ClosedError,
 * CommitError, CorruptDatabaseError) pass through unchanged.
 */
export type DocStoreErrorCode =
  /** The stored catalog and this schema disagree in a way this handle cannot work with. */
  | "schema"
  /** A write would give two documents one value of a unique index. `ids` is [incoming, owner]. */
  | "unique"
  /** A query on an index whose backfill met data it cannot hold. `ids` names the documents. */
  | "index-failed"
  /** A malformed query. */
  | "query"
  /** `after` is outside the query's range, or was made before a `clear` or a redefinition. */
  | "cursor"
  /** A bad or repeated id, `modify` changed the id, or a value an index cannot hold. Nothing is stored. */
  | "document";

export class DocStoreError extends Error {
  constructor(
    readonly code: DocStoreErrorCode,
    message: string,
    /** Set for "unique" and "index-failed". */
    readonly ids?: readonly string[],
  ) {
    super(message);
    this.name = "DocStoreError";
  }
}

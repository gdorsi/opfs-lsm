import { DocStoreError } from "@opfs-lsm/docstore";
import { OpfsLsmError } from "@opfs-lsm/kv";
import type { StandardIssue } from "./schema.js";

export type DbErrorTag = AnyDbError["_tag"];

/**
 * Every error the library throws on purpose. `_tag` is fixed per class, so
 * Effect's `catchTag` narrows on it after `Effect.tryPromise`. `code` is the
 * finer reason.
 */
export abstract class DbError extends Error {
  abstract readonly _tag: DbErrorTag;
  abstract readonly code: string;
}

/** A write refused before anything was stored. */
export class ValidationError extends DbError {
  readonly _tag = "ValidationError";
  constructor(
    /**
     * - `invalid`: the validator returned `issues`.
     * - `async`: the validator returned a Promise.
     * - `id`: no usable string id, an id given twice in one call, or `update` changed it.
     * - `indexed-field`: a field an index names is missing, or holds a value the index cannot.
     */
    readonly code: "invalid" | "async" | "id" | "indexed-field",
    message: string,
    readonly collection: string,
    readonly id?: string,
    readonly issues?: readonly StandardIssue[],
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

export class ConflictError extends DbError {
  readonly _tag = "ConflictError";
  constructor(
    readonly code: "duplicate" | "unique",
    message: string,
    readonly collection: string,
    /** `duplicate`: the id that exists. `unique`: the incoming id, then the id that holds the value. */
    readonly ids: readonly string[],
  ) {
    super(message);
    this.name = "ConflictError";
  }
}

export class NotFoundError extends DbError {
  readonly _tag = "NotFoundError";
  readonly code = "missing";
  constructor(
    readonly collection: string,
    readonly id: string,
  ) {
    super(`"${collection}" has no document "${id}"`);
    this.name = "NotFoundError";
  }
}

export class QueryError extends DbError {
  readonly _tag = "QueryError";
  constructor(
    readonly code: "operand" | "source",
    message: string,
  ) {
    super(message);
    this.name = "QueryError";
  }
}

export class SchemaError extends DbError {
  readonly _tag = "SchemaError";
  constructor(
    /** `version`: this version is stored with other collections or indexes. `catalog`: any other disagreement. */
    readonly code: "version" | "catalog",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SchemaError";
  }
}

export class ClosedError extends DbError {
  readonly _tag = "ClosedError";
  constructor(readonly code: "closed" | "destroyed") {
    super(code === "closed" ? "the database is closed" : "the database was deleted");
    this.name = "ClosedError";
  }
}

export class StorageError extends DbError {
  readonly _tag = "StorageError";
  constructor(
    readonly code: "commit" | "quota" | "unavailable" | "corrupt" | "limit" | "index-failed",
    message: string,
    options: { readonly cause: unknown },
  ) {
    super(message, options);
    this.name = "StorageError";
  }
}

/** Every DbError, as a union: a `switch` on `_tag`, or Effect's `catchTag`, narrows it to one class. */
export type AnyDbError = ValidationError | ConflictError | NotFoundError | QueryError | SchemaError | ClosedError | StorageError;

/**
 * The one mapping from docstore's and kv's errors to DbError, applied to
 * every rejection of the public API and to the error that ends a
 * subscription. Their classes carry no `_tag`, and their codes are the
 * storage's own. A DbError passes through, and so does anything else: an
 * error the app's own callback or validator threw, or a bug.
 */
export function wrap(err: unknown, collection = ""): unknown {
  if (err instanceof OpfsLsmError) {
    if (err.code === "closed") return new ClosedError("closed");
    return new StorageError(err.code === "constraint" ? "limit" : err.code, err.message, { cause: err });
  }
  if (!(err instanceof DocStoreError)) return err;
  switch (err.code) {
    case "unique":
      return new ConflictError("unique", err.message, collection, err.ids ?? []);
    // db checks each id with docstore's own isDocId, and repeated or changed ids, before docstore sees them. What is left is a value an index cannot hold.
    case "document":
      return new ValidationError("indexed-field", err.message, collection);
    case "version":
    case "schema":
      return new SchemaError(err.code === "version" ? "version" : "catalog", err.message, { cause: err });
    case "index-failed":
      return new StorageError("index-failed", err.message, { cause: err });
    // "query" and "cursor" would be a bug of the planner.
    default:
      return err;
  }
}

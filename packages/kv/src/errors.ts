export type ErrorCode =
  | "commit"
  | "closed"
  | "corrupt"
  | "constraint"
  | "conflict"
  | "unavailable";

export class OpfsLsmError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OpfsLsmError";
  }
}

export class ConstraintError extends OpfsLsmError {
  constructor(message: string) {
    super("constraint", message);
    this.name = "ConstraintError";
  }
}

export class CommitError extends OpfsLsmError {
  constructor(message: string) {
    super("commit", message);
    this.name = "CommitError";
  }
}

export class ClosedError extends OpfsLsmError {
  constructor(message: string) {
    super("closed", message);
    this.name = "ClosedError";
  }
}

export class CorruptDatabaseError extends OpfsLsmError {
  constructor(message: string) {
    super("corrupt", message);
    this.name = "CorruptDatabaseError";
  }
}

/** Optimistic concurrency failure — retry the transaction. */
export class ConflictError extends OpfsLsmError {
  constructor(message = "transaction conflict") {
    super("conflict", message);
    this.name = "ConflictError";
  }
}

export class StorageUnavailableError extends OpfsLsmError {
  constructor(message: string) {
    super("unavailable", message);
    this.name = "StorageUnavailableError";
  }
}

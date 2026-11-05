export type ErrorCode =
  | "commit"
  | "closed"
  | "corrupt"
  | "constraint"
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

export class StorageUnavailableError extends OpfsLsmError {
  constructor(message: string) {
    super("unavailable", message);
    this.name = "StorageUnavailableError";
  }
}

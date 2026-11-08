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

/**
 * The error a tab rethrows for a host error that crossed a MessagePort as
 * a code and a message (structured clone drops the class).
 */
export function errorOfCode(code: ErrorCode | undefined, message: string): Error {
  switch (code) {
    case "commit":
      return new CommitError(message);
    case "closed":
      return new ClosedError(message);
    case "corrupt":
      return new CorruptDatabaseError(message);
    case "constraint":
      return new ConstraintError(message);
    case "unavailable":
      return new StorageUnavailableError(message);
    default:
      return new Error(message);
  }
}

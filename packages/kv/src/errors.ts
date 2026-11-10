export type ErrorCode =
  | "commit"
  | "closed"
  | "corrupt"
  | "constraint"
  | "unavailable"
  | "quota";

export class OpfsLsmError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
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
  constructor(message: string, options?: ErrorOptions) {
    super("unavailable", message, options);
    this.name = "StorageUnavailableError";
  }
}

export class StorageFullError extends OpfsLsmError {
  constructor(message: string) {
    super("quota", message);
    this.name = "StorageFullError";
  }
}

/**
 * The code a host error crosses a MessagePort with. A write the browser
 * refuses for lack of space is a DOMException, not an OpfsLsmError, so it is
 * recognised by name.
 */
export function codeOfError(err: unknown): ErrorCode | undefined {
  if (err instanceof OpfsLsmError) return err.code;
  if (err instanceof Error && err.name === "QuotaExceededError") return "quota";
  // No code: the tab gets a plain Error with the host's message, on purpose.
  return undefined;
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
    case "quota":
      return new StorageFullError(message);
    default:
      // No code: a plain Error with the host's message, on purpose.
      return new Error(message);
  }
}

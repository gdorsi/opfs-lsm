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

/** `StorageUnavailableError` for `what`, which the browser has and which failed with `cause`. */
export function unavailable(what: string, cause: unknown): StorageUnavailableError {
  const detail = cause instanceof Error ? ` (${cause.name}: ${cause.message})` : "";
  return new StorageUnavailableError(`${what} failed${detail}`, { cause });
}

export class StorageFullError extends OpfsLsmError {
  constructor(message: string, options?: ErrorOptions) {
    super("quota", message, options);
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

/** Whether `err` is an object named `name`, as a DOMException is. */
export function hasErrorName(err: unknown, name: string): boolean {
  return typeof err === "object" && err !== null && "name" in err && err.name === name;
}

/** Whether the browser refused a write for lack of space. */
export function isQuota(err: unknown): boolean {
  return codeOfError(err) === "quota";
}

const ERROR_OF_CODE: Record<ErrorCode, new (message: string) => OpfsLsmError> = {
  commit: CommitError,
  closed: ClosedError,
  corrupt: CorruptDatabaseError,
  constraint: ConstraintError,
  unavailable: StorageUnavailableError,
  quota: StorageFullError,
};

/**
 * The error a tab rethrows for a host error that crossed a MessagePort as
 * a code and a message (structured clone drops the class).
 */
export function errorOfCode(code: ErrorCode | undefined, message: string): Error {
  // No code: a plain Error with the host's message, on purpose.
  return code !== undefined && Object.hasOwn(ERROR_OF_CODE, code) ? new ERROR_OF_CODE[code](message) : new Error(message);
}

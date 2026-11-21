/** Every error this package throws. kv's own errors (ConstraintError, StorageFullError, ...) pass through unchanged. */
export type SpacesErrorCode =
  /** A field validator refused a value, or returned a Promise. `details` names the field. Also a malformed id, cursor or query. */
  | "validation"
  /** `update` or `open` on a record that is missing or deleted. */
  | "not-found"
  /** A write to a record that was deleted: re-creating a deleted `keyedRecordId`, or taking a file that is gone. */
  | "deleted"
  /** Another tab stored a newer schema version. This tab must reload. */
  | "stale-schema"
  /** Schema declarations disagree with each other (unknown ref target, reserved name, non-scalar index field). */
  | "schema"
  /** A FileRef already belongs to another record. */
  | "file-attached"
  | "too-large"
  /** The operation needs the server and none answered (join, reading a remote file). */
  | "offline"
  /** Invite link unknown, used up or revoked. */
  | "invite"
  /** The server refused a membership change. `details` is the RefusedReason ("last-admin", "not-authorized", ...). */
  | "membership"
  /** A write to a space where this account is a reader, or was removed. */
  | "read-only"
  /** A stored account secret differs from `OpenOptions.account`. */
  | "account"
  | "decrypt"
  | "protocol"
  | "closed";

export class SpacesError extends Error {
  readonly code: SpacesErrorCode;
  readonly details: unknown;
  constructor(code: SpacesErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "SpacesError";
    this.code = code;
    this.details = details;
  }
}

export {
  openDb,
  destroyDb,
  prefixBound,
  type OpenOptions,
  type Db,
  type BatchTx,
  type Entry,
  type Range,
  type ViewSnapshot,
  type ChangeEvent,
  type ChangeListener,
  type ChangeKind,
  type ChangeOp,
} from "./db.js";
export {
  OpfsLsmError,
  ConstraintError,
  CommitError,
  ClosedError,
  CorruptDatabaseError,
  StorageUnavailableError,
  StorageFullError,
} from "./errors.js";

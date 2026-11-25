export {
  openDb,
  destroyDb,
  prefixBound,
  type OpenOptions,
  type Db,
  type BatchTx,
  type KeyBounds,
  type DeleteRangeOptions,
  type Decode,
  type Entry,
  type Range,
  type ViewSnapshot,
  type ChangeEvent,
  type ChangeListener,
  type ChangeKind,
  type ChangeOp,
  type StorageFull,
} from "./db.js";
export type { SyncReads } from "./opfs/async-fs.js";
export {
  OpfsLsmError,
  ConstraintError,
  CommitError,
  ClosedError,
  CorruptDatabaseError,
  StorageUnavailableError,
  StorageFullError,
} from "./errors.js";

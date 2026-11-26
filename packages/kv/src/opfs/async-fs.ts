/** Published file bytes. Stages are not readable until finish. */
export interface FileWriter {
  write(bytes: Uint8Array): Promise<void>;
  /** Publish. Second finish throws. */
  finish(): Promise<void>;
  abort(): Promise<void>;
}

/**
 * A published run file held open. While any tab holds `path` open,
 * `removeUnlessOpen(path)` refuses. Run files never change, so `size` and
 * every read are stable.
 */
export interface OpenFile {
  readonly size: number;
  /** Exactly `length` bytes at `offset`. */
  read(offset: number, length: number): Promise<Uint8Array>;
  /** Release the hold. Idempotent. */
  close(): void;
}

/**
 * What a tab uses of the run directory: it reads manifests and run files and
 * never writes them. Only the host does (`AsyncFs`).
 */
export interface ReadFs {
  /** At most `length` bytes from `offset`. Pass Infinity to read to the end. */
  read(
    path: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array | undefined>;
  /**
   * Hold `path` open. Undefined when the file is gone. The hold is taken
   * before the existence check, so a concurrent `removeUnlessOpen` either
   * removes first (this returns undefined) or sees the hold.
   */
  open(path: string): Promise<OpenFile | undefined>;
  list(dir: string): Promise<readonly string[]>;
}

/**
 * How a host writes a file. "writable": through `createWritable()`. "staged":
 * where OPFS has none, through a sync access handle on `<name>.crswap`, then
 * a rename. Undefined: the host writes no file.
 */
export type FileWrites = "writable" | "staged" | undefined;

export interface AsyncFs extends ReadFs {
  remove(path: string): Promise<void>;
  /** Remove `path` unless some tab holds it open. True when it is gone. */
  removeUnlessOpen(path: string): Promise<boolean>;
  /** Replace published file only when finish resolves. No append. */
  create(path: string): Promise<FileWriter>;
}

/**
 * A database folder `destroyDb` can remove. It reads the manifests and writes
 * no file, so the page carries no file writer. Kept off `AsyncFs`, so the fs
 * of `openDb` and of the SharedWorker carries no removal.
 */
export interface RemovableFolder extends ReadFs {
  /**
   * Remove every file and the database folder: `m/` first, so a crash part
   * way leaves no manifest to adopt. Ignores open holds: `destroyDb` calls it
   * once every handle closed, under the compaction and ingest locks.
   * Idempotent. No other call is valid on this fs afterwards.
   */
  removeFolder(): Promise<void>;
}

/** A folder a test's host writes and its `destroyDb` removes. */
export interface RemovableFs extends AsyncFs, RemovableFolder {}

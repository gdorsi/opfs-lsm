import type { DbName } from "../check.js";

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
  /** The same bytes with no wait, or undefined when this read has to go through `read`. Only a file opened for sync reads has it (`OpenOptions.syncReads`). */
  readSync?(offset: number, length: number): Uint8Array | undefined;
  /** Whether `readSync` answers now. */
  syncReady?(): boolean;
  /** Release the hold. Idempotent. */
  close(): void;
}

/** Reads `readSync` served, and their bytes. */
export type SyncReadCount = { reads: number; bytes: number };

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
  /**
   * Let go of everything that would stop `destroyDb` from removing the
   * folder, whatever still holds a file open: from here on no file answers
   * `readSync`, and files keep reading through `read`. Undefined when the
   * fs holds nothing of the kind, so there is nothing to wait for.
   * Idempotent, and never rejects.
   */
  quiesce?(): Promise<void> | undefined;
  /** What `readSync` served on this fs's files, when it has such files and they are being served. */
  syncReads?(): SyncReadCount | undefined;
}

declare const opaque: unique symbol;

/** What `OpenOptions.syncReads` takes. Its one value is `syncReads` from `@opfs-lsm/kv/sync-reads`. */
export type SyncReads = {
  readonly [opaque]: true;
  /** The read side of `opfs-lsm/<name>/` under `parent`, as `openBrowserReadFs` makes it, with sync reads where the page can have them. */
  readonly readFs: (name: DbName, parent: Promise<FileSystemDirectoryHandle>) => ReadFs;
};

export interface AsyncFs extends ReadFs {
  remove(path: string): Promise<void>;
  /** Remove `path` unless some tab holds it open. True when it is gone. */
  removeUnlessOpen(path: string): Promise<boolean>;
  /** Replace published file only when finish resolves. No append. */
  create(path: string): Promise<FileWriter>;
}

/** A database folder `destroyDb` can remove. Kept off `AsyncFs`, so the fs of `openDb` and of the SharedWorker carries no removal. */
export interface RemovableFs extends AsyncFs {
  /**
   * Remove every file and the database folder: `m/` first, so a crash part
   * way leaves no manifest to adopt. Ignores open holds: `destroyDb` calls it
   * once every handle closed, under the compaction and ingest locks.
   * Idempotent. No other call is valid on this fs afterwards.
   */
  removeFolder(): Promise<void>;
}

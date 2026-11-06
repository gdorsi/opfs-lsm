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

export interface AsyncFs {
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
  remove(path: string): Promise<void>;
  /** Remove `path` unless some tab holds it open. True when it is gone. */
  removeUnlessOpen(path: string): Promise<boolean>;
  /** Replace published file only when finish resolves. No append. */
  create(path: string): Promise<FileWriter>;
}

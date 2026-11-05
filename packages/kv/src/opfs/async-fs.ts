/** Published file bytes. Stages are not readable until finish. */
export interface FileWriter {
  write(bytes: Uint8Array): Promise<void>;
  /** Publish. Second finish throws. */
  finish(): Promise<void>;
  abort(): Promise<void>;
}

export interface AsyncFs {
  /** At most `length` bytes from `offset`. Pass Infinity to read to the end. */
  read(
    path: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array | undefined>;
  list(dir: string): Promise<readonly string[]>;
  remove(path: string): Promise<void>;
  /** Replace published file only when finish resolves. No append. */
  create(path: string): Promise<FileWriter>;
}

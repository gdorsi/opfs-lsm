import type { AsyncFs, FileWrites, FileWriter, OpenFile, ReadFs, RemovableFolder } from "./async-fs.js";
import { checkDbName, type DbName } from "../check.js";
import { CorruptDatabaseError, hasErrorName } from "../errors.js";
import { runLock } from "../locks.js";
import { coalesceReads } from "./coalesce-reads.js";

function splitPath(path: string): string[] {
  return path.split("/").filter((p) => p.length > 0 && p !== ".");
}

/**
 * The read side of the async OPFS adapter rooted at `opfs-lsm/<dbName>/`,
 * which is all a tab uses. An open file is a shared Web Lock per path, held
 * across tabs and workers of the origin, so the host deletes a run only when
 * no reader holds it.
 */
class BrowserReadFs implements ReadFs {
  /** `root` can be a lookup still running: every call waits for it. */
  constructor(
    protected readonly root: FileSystemDirectoryHandle | Promise<FileSystemDirectoryHandle>,
    protected readonly dbName: DbName,
  ) {}

  /**
   * Directory handles by path. Only `destroyDb` removes a directory, after
   * every handle on the database closed, and no host keeps a BrowserFs past
   * one operation, so a handle stays good as long as it is used. A lookup
   * costs a trip to the browser process.
   */
  private readonly dirs = new Map<string, Promise<FileSystemDirectoryHandle>>();

  protected async dir(segments: readonly string[], create: boolean): Promise<FileSystemDirectoryHandle> {
    if (segments.length === 0) return this.root;
    const key = segments.join("/");
    const known = this.dirs.get(key);
    if (known) {
      try {
        return await known;
      } catch (err) {
        // That lookup may have been one that does not create.
        if (!create) throw err;
      }
    }
    const found = this.dir(segments.slice(0, -1), create).then((parent) =>
      parent.getDirectoryHandle(segments[segments.length - 1]!, { create }),
    );
    this.dirs.set(key, found);
    found.catch(() => {
      if (this.dirs.get(key) === found) this.dirs.delete(key);
    });
    return found;
  }

  protected async fileHandle(path: string, create: boolean): Promise<FileSystemFileHandle> {
    const parts = splitPath(path);
    if (parts.length === 0) throw new Error("empty path");
    const dir = await this.dir(parts.slice(0, -1), create);
    return dir.getFileHandle(parts[parts.length - 1]!, { create });
  }

  protected lockName(path: string): string {
    return runLock(this.dbName, path);
  }

  async open(path: string): Promise<OpenFile | undefined> {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    // Looked up while the lock is requested. `getFile` below is the
    // existence check, and it runs once the lock is held.
    const handle = this.fileHandle(path, false);
    handle.catch(() => undefined);
    await new Promise<void>((granted, failed) => {
      navigator.locks
        .request(this.lockName(path), { mode: "shared" }, () => {
          granted();
          return held;
        })
        .catch(failed);
    });
    let file: File;
    try {
      file = await (await handle).getFile();
    } catch (err) {
      release();
      if (hasErrorName(err, "NotFoundError")) return undefined;
      throw err;
    }
    const read = coalesceReads((offset, length) => file.slice(offset, offset + length).arrayBuffer());
    return {
      size: file.size,
      read: async (offset, length) => {
        if (offset + length > file.size) {
          throw new CorruptDatabaseError(`short read: ${path}`);
        }
        return read(offset, length);
      },
      close: release,
    };
  }

  async read(
    path: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array | undefined> {
    try {
      const handle = await this.fileHandle(path, false);
      const file = await handle.getFile();
      if (offset >= file.size) return new Uint8Array(0);
      const end = Math.min(file.size, offset + length);
      const buf = await file.slice(offset, end).arrayBuffer();
      return new Uint8Array(buf);
    } catch (err) {
      if (hasErrorName(err, "NotFoundError")) return undefined;
      throw err;
    }
  }

  async list(dir: string): Promise<readonly string[]> {
    try {
      const parts = splitPath(dir);
      const handle = await this.dir(parts, false);
      const names: string[] = [];
      // FileSystemDirectoryHandle is async-iterable as [name, handle] in browsers.
      const iter = (
        handle as FileSystemDirectoryHandle & {
          entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
        }
      ).entries();
      for await (const [name] of iter) {
        names.push(name);
      }
      return names;
    } catch (err) {
      if (hasErrorName(err, "NotFoundError")) return [];
      throw err;
    }
  }
}

/** What the DOM lib leaves off a file handle: sync access, which it gives to a dedicated Worker only, and `move`. */
type StagedHandle = FileSystemFileHandle & {
  createSyncAccessHandle(): Promise<SyncAccess>;
  move(dir: FileSystemDirectoryHandle, name: string): Promise<void>;
};

/** The first spec made all but `write` asynchronous, and older browsers return promises, so each call is awaited. */
type SyncAccess = {
  truncate(size: number): void | Promise<void>;
  write(bytes: Uint8Array, options: { at: number }): number;
  flush(): void | Promise<void>;
  close(): void | Promise<void>;
};

/** A file being written, by either way: `close` publishes it, and `abort` leaves the published file as it was. */
type Sink = {
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
};

/**
 * The adapter the host uses: reads, and the writes. A file is published
 * whole, by the `close` of a `createWritable()`, or by the rename of a staged
 * file where `writes` says so.
 */
export class BrowserFs extends BrowserReadFs implements AsyncFs {
  constructor(
    root: FileSystemDirectoryHandle | Promise<FileSystemDirectoryHandle>,
    dbName: DbName,
    private readonly writes?: FileWrites,
  ) {
    super(root, dbName);
  }

  async removeUnlessOpen(path: string): Promise<boolean> {
    return await navigator.locks.request(
      this.lockName(path),
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        if (!lock) return false;
        await ignoreNotFound(this.remove(path));
        return true;
      },
    );
  }

  /** The directory of the file at `path`, and the file's name in it. */
  private async entry(path: string, create: boolean): Promise<[FileSystemDirectoryHandle, string]> {
    const parts = splitPath(path);
    const name = parts.pop()!;
    return [await this.dir(parts, create), name];
  }

  async remove(path: string): Promise<void> {
    const [dir, name] = await this.entry(path, false);
    await dir.removeEntry(name);
  }

  async create(path: string): Promise<FileWriter> {
    const file = await (this.writes === "staged" ? this.stage(path) : this.writable(path));
    let done = false;
    return {
      write: async (bytes: Uint8Array) => {
        if (done) throw new Error("write after finish/abort");
        await file.write(bytes);
      },
      finish: async () => {
        if (done) throw new Error("second finish");
        done = true;
        await file.close();
      },
      abort: async () => {
        if (done) return;
        done = true;
        await file.abort();
      },
    };
  }

  /** Default createWritable: new staged version, no keepExistingData. */
  private async writable(path: string): Promise<Sink> {
    const writable = await (await this.fileHandle(path, true)).createWritable();
    return {
      write: (bytes) => writable.write(new Uint8Array(bytes)),
      close: () => writable.close(),
      abort: () => writable.abort(),
    };
  }

  /**
   * Where OPFS has no `createWritable()`. The staged file takes the name
   * Chrome's `createWritable()` leaves after a crash, so what removes those
   * removes a staged file a crash left, and the next write of `path` writes
   * over it. The handle locks the staged file, so a step that fails closes
   * and removes it: the host writes a refused file again at once.
   */
  private async stage(path: string): Promise<Sink> {
    const [dir, name] = await this.entry(path, true);
    const swap = `${name}.crswap`;
    const handle = (await dir.getFileHandle(swap, { create: true })) as StagedHandle;
    let access: SyncAccess | undefined;
    let at = 0;
    // A step that failed has removed the staged file already, and an abort after it resolves, as a writable's does.
    const abort = async (): Promise<void> => {
      await access?.close();
      await ignoreNotFound(dir.removeEntry(swap));
    };
    const orAbort = async (step: () => unknown): Promise<void> => {
      try {
        await step();
      } catch (err) {
        await abort().catch(() => undefined);
        throw err;
      }
    };
    await orAbort(async () => {
      access = await handle.createSyncAccessHandle();
      await access.truncate(0);
    });
    return {
      write: (bytes) =>
        orAbort(() => {
          let written = 0;
          try {
            written = access!.write(bytes, { at });
          } catch (err) {
            // Safari fails a write no byte of which fits with InvalidStateError: it wrote none.
            if (!hasErrorName(err, "InvalidStateError")) throw err;
          }
          at += written;
          // A full disk writes the part that fits, and is a refusal like a full quota.
          if (written < bytes.byteLength) throw new DOMException("short write", "QuotaExceededError");
        }),
      close: () =>
        orAbort(async () => {
          // On disk before the rename, so a power loss leaves the whole file or none.
          await access!.flush();
          await access!.close();
          await handle.move(dir, name);
        }),
      abort,
    };
  }
}

/**
 * How this worker writes an OPFS file. With `createWritable()` it answers
 * without a file call. Without, it writes one scratch file in `opfs-lsm/` as
 * the host would, and answers "staged" only when the byte reads back under
 * the final name. The spec gives sync access handles to dedicated Workers
 * only and Safari 18.6 also gives them to a SharedWorker, so whether one
 * works here is found by trying. The scratch name is this worker's own: a
 * second handle on one file is refused.
 */
export async function fileWrites(): Promise<FileWrites> {
  const writable: unknown = globalThis.FileSystemFileHandle?.prototype.createWritable;
  if (writable) return "writable";
  const fs = new BrowserFs(openParent(), "" as DbName, "staged");
  const name = `probe-${Math.random()}`;
  try {
    const writer = await fs.create(name);
    await writer.write(new Uint8Array(1));
    await writer.finish();
    if ((await fs.read(name, 0, 2))?.byteLength === 1) return "staged";
  } catch {
    // No sync access handle here, or no rename: the host writes no file.
  } finally {
    await fs.remove(name).catch(() => undefined);
  }
  return undefined;
}

/** `opfs-lsm/`, the folder that holds every database's folder, created when missing. It names no database. */
export async function openParent(): Promise<FileSystemDirectoryHandle> {
  return (await navigator.storage.getDirectory()).getDirectoryHandle("opfs-lsm", { create: true });
}

/**
 * What a tab opens: the read side of `opfs-lsm/<name>/` under `parent`
 * (`openParent`), created when missing. Only `openDb` creates it. Returns
 * at once: the lookup runs behind the first call.
 */
export function openBrowserReadFs(name: DbName, parent: Promise<FileSystemDirectoryHandle>): BrowserReadFs {
  const root = parent.then((lsm) => lsm.getDirectoryHandle(name, { create: true }));
  root.catch(() => undefined);
  return new BrowserReadFs(root, name);
}

/** The full adapter, creating the folder as `openDb` does. Tests and proofs only: the host finds the folder with `findBrowserFs`. */
export async function openBrowserFs(name: string): Promise<BrowserFs> {
  const dbName: DbName = checkDbName(name);
  return new BrowserFs(await (await openParent()).getDirectoryHandle(dbName, { create: true }), dbName);
}

/** `opfs-lsm/` and `opfs-lsm/<name>/`, or undefined when either does not exist. Creates nothing. */
async function findFolder(dbName: DbName): Promise<[FileSystemDirectoryHandle, FileSystemDirectoryHandle] | undefined> {
  try {
    const lsm = await (await navigator.storage.getDirectory()).getDirectoryHandle("opfs-lsm");
    return [lsm, await lsm.getDirectoryHandle(dbName)];
  } catch (err) {
    if (hasErrorName(err, "NotFoundError")) return undefined;
    throw err;
  }
}

/**
 * `opfs-lsm/<name>/` if it exists, else undefined. Creates nothing, not even
 * `opfs-lsm/`. The SharedWorker resolves the folder with it at the start of
 * every operation.
 */
export async function findBrowserFs(name: string, writes?: FileWrites): Promise<BrowserFs | undefined> {
  const dbName: DbName = checkDbName(name);
  const found = await findFolder(dbName);
  return found && new BrowserFs(found[1], dbName, writes);
}

async function ignoreNotFound(removal: Promise<void>): Promise<void> {
  try {
    await removal;
  } catch (err) {
    if (!hasErrorName(err, "NotFoundError")) throw err;
  }
}

/** `parent` is `opfs-lsm/`, so `removeFolder` can remove `root` itself. */
class RemovableBrowserFs extends BrowserReadFs implements RemovableFolder {
  constructor(
    private readonly parent: FileSystemDirectoryHandle,
    root: FileSystemDirectoryHandle,
    dbName: DbName,
  ) {
    super(root, dbName);
  }

  async removeFolder(): Promise<void> {
    await ignoreNotFound((await this.root).removeEntry("m", { recursive: true }));
    await ignoreNotFound(this.parent.removeEntry(this.dbName, { recursive: true }));
  }
}

/** The folder `destroyDb` removes, found as `findBrowserFs` finds it. */
export async function findRemovableBrowserFs(dbName: DbName): Promise<RemovableFolder | undefined> {
  const found = await findFolder(dbName);
  return found && new RemovableBrowserFs(found[0], found[1], dbName);
}

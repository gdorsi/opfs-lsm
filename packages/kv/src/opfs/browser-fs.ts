import type { AsyncFs, FileWriter, OpenFile, ReadFs, RemovableFs } from "./async-fs.js";
import { checkDbName, type DbName } from "../check.js";
import { CorruptDatabaseError } from "../errors.js";
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
      if (isNotFound(err)) return undefined;
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
      if (isNotFound(err)) return undefined;
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
      if (isNotFound(err)) return [];
      throw err;
    }
  }
}

/**
 * The adapter the host uses: reads, and the writes.
 * Publish = createWritable (no keepExistingData) + close.
 */
export class BrowserFs extends BrowserReadFs implements AsyncFs {
  async removeUnlessOpen(path: string): Promise<boolean> {
    return await navigator.locks.request(
      this.lockName(path),
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        if (!lock) return false;
        try {
          await this.remove(path);
        } catch (err) {
          if (!isNotFound(err)) throw err;
        }
        return true;
      },
    );
  }

  async remove(path: string): Promise<void> {
    const parts = splitPath(path);
    if (parts.length === 0) throw new Error("cannot remove root");
    const fileName = parts[parts.length - 1]!;
    const dir = await this.dir(parts.slice(0, -1), false);
    await dir.removeEntry(fileName);
  }

  async create(path: string): Promise<FileWriter> {
    const handle = await this.fileHandle(path, true);
    // Default createWritable: new staged version, no keepExistingData.
    const writable = await handle.createWritable();
    let done = false;
    return {
      write: async (bytes: Uint8Array) => {
        if (done) throw new Error("write after finish/abort");
        const chunk = new Uint8Array(bytes.byteLength);
        chunk.set(bytes);
        await writable.write(chunk);
      },
      finish: async () => {
        if (done) throw new Error("second finish");
        done = true;
        await writable.close();
      },
      abort: async () => {
        if (done) return;
        done = true;
        await writable.abort();
      },
    };
  }
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name: string }).name === "NotFoundError"
  );
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
    if (isNotFound(err)) return undefined;
    throw err;
  }
}

/**
 * `opfs-lsm/<name>/` if it exists, else undefined. Creates nothing, not even
 * `opfs-lsm/`. The SharedWorker resolves the folder with it at the start of
 * every operation.
 */
export async function findBrowserFs(name: string): Promise<BrowserFs | undefined> {
  const dbName: DbName = checkDbName(name);
  const found = await findFolder(dbName);
  return found && new BrowserFs(found[1], dbName);
}

async function ignoreNotFound(removal: Promise<void>): Promise<void> {
  try {
    await removal;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

/** `parent` is `opfs-lsm/`, so `removeFolder` can remove `root` itself. */
class RemovableBrowserFs extends BrowserFs implements RemovableFs {
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
export async function findRemovableBrowserFs(dbName: DbName): Promise<RemovableFs | undefined> {
  const found = await findFolder(dbName);
  return found && new RemovableBrowserFs(found[0], found[1], dbName);
}

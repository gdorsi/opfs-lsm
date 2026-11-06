import type { AsyncFs, FileWriter, OpenFile } from "./async-fs.js";
import { checkDbName, type DbName } from "../check.js";
import { CorruptDatabaseError } from "../errors.js";

function splitPath(path: string): string[] {
  return path.split("/").filter((p) => p.length > 0 && p !== ".");
}

async function getDir(
  root: FileSystemDirectoryHandle,
  segments: string[],
  create: boolean,
): Promise<FileSystemDirectoryHandle> {
  let dir = root;
  for (const seg of segments) {
    dir = await dir.getDirectoryHandle(seg, { create });
  }
  return dir;
}

async function getFileHandle(
  root: FileSystemDirectoryHandle,
  path: string,
  create: boolean,
): Promise<FileSystemFileHandle> {
  const parts = splitPath(path);
  if (parts.length === 0) throw new Error("empty path");
  const fileName = parts[parts.length - 1]!;
  const dir = await getDir(root, parts.slice(0, -1), create);
  return dir.getFileHandle(fileName, { create });
}

/**
 * Async OPFS adapter rooted at `opfs-lsm/<dbName>/`.
 * Publish = createWritable (no keepExistingData) + close.
 * An open file is a shared Web Lock per path, held across tabs and workers
 * of the origin, so the host deletes a run only when no reader holds it.
 */
export class BrowserFs implements AsyncFs {
  constructor(
    private readonly root: FileSystemDirectoryHandle,
    private readonly dbName: DbName,
  ) {}

  private lockName(path: string): string {
    return `opfs-lsm:${this.dbName}:run:${path}`;
  }

  async open(path: string): Promise<OpenFile | undefined> {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
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
      file = await (await getFileHandle(this.root, path, false)).getFile();
    } catch (err) {
      release();
      if (isNotFound(err)) return undefined;
      throw err;
    }
    return {
      size: file.size,
      read: async (offset, length) => {
        if (offset + length > file.size) {
          throw new CorruptDatabaseError(`short read: ${path}`);
        }
        return new Uint8Array(
          await file.slice(offset, offset + length).arrayBuffer(),
        );
      },
      close: release,
    };
  }

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

  async read(
    path: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array | undefined> {
    try {
      const handle = await getFileHandle(this.root, path, false);
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
      const handle =
        parts.length === 0
          ? this.root
          : await getDir(this.root, parts, false);
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

  async remove(path: string): Promise<void> {
    const parts = splitPath(path);
    if (parts.length === 0) throw new Error("cannot remove root");
    const fileName = parts[parts.length - 1]!;
    const dir = await getDir(this.root, parts.slice(0, -1), false);
    await dir.removeEntry(fileName);
  }

  async create(path: string): Promise<FileWriter> {
    const handle = await getFileHandle(this.root, path, true);
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

/** Open (or create) `opfs-lsm/<name>/` under the origin private file system. */
export async function openBrowserFs(name: string): Promise<BrowserFs> {
  const dbName: DbName = checkDbName(name);
  const root = await navigator.storage.getDirectory();
  const lsm = await root.getDirectoryHandle("opfs-lsm", { create: true });
  const db = await lsm.getDirectoryHandle(dbName, { create: true });
  return new BrowserFs(db, dbName);
}

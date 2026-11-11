import { CorruptDatabaseError } from "../errors.js";
import type { AsyncFs, FileWriter, OpenFile } from "./async-fs.js";

/**
 * In-memory AsyncFs: publish-on-finish. Stages are invisible until finish.
 */
export class MemoryFs implements AsyncFs {
  private readonly published = new Map<string, Uint8Array>();
  private readonly stages = new Map<string, Uint8Array[]>();
  /** Open holds per path, standing in for BrowserFs's shared Web Locks. */
  private readonly holds = new Map<string, number>();

  async read(
    path: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array | undefined> {
    const file = this.published.get(path);
    if (!file) return undefined;
    if (offset >= file.byteLength) return new Uint8Array(0);
    const end = Math.min(file.byteLength, offset + length);
    return file.slice(offset, end);
  }

  async open(path: string): Promise<OpenFile | undefined> {
    this.holds.set(path, (this.holds.get(path) ?? 0) + 1);
    let held = true;
    const close = () => {
      if (!held) return;
      held = false;
      const n = this.holds.get(path)! - 1;
      if (n === 0) this.holds.delete(path);
      else this.holds.set(path, n);
    };
    const file = this.published.get(path);
    if (!file) {
      close();
      return undefined;
    }
    return {
      size: file.byteLength,
      read: async (offset, length) => {
        if (offset + length > file.byteLength) {
          throw new CorruptDatabaseError(`short read: ${path}`);
        }
        return file.slice(offset, offset + length);
      },
      close,
    };
  }

  async removeUnlessOpen(path: string): Promise<boolean> {
    if (this.holds.has(path)) return false;
    this.published.delete(path);
    return true;
  }

  async list(dir: string): Promise<readonly string[]> {
    const prefix = dir === "" || dir.endsWith("/") ? dir : `${dir}/`;
    const names: string[] = [];
    for (const path of this.published.keys()) {
      if (path.startsWith(prefix) || path === dir) {
        names.push(path.slice(prefix.length).split("/")[0] || path);
      }
    }
    // Unique first path segment under dir
    return [...new Set(names.filter(Boolean))];
  }

  /** Test helper: full published paths. */
  publishedPaths(): string[] {
    return [...this.published.keys()].sort();
  }

  async remove(path: string): Promise<void> {
    this.published.delete(path);
  }

  async removeAll(): Promise<void> {
    this.published.clear();
  }

  async create(path: string): Promise<FileWriter> {
    if (this.stages.has(path)) {
      throw new Error(`stage already open for ${path}`);
    }
    const chunks: Uint8Array[] = [];
    this.stages.set(path, chunks);
    let done = false;
    return {
      write: async (bytes: Uint8Array) => {
        if (done) throw new Error("write after finish/abort");
        chunks.push(new Uint8Array(bytes));
      },
      finish: async () => {
        if (done) throw new Error("second finish");
        done = true;
        this.stages.delete(path);
        let total = 0;
        for (const c of chunks) total += c.byteLength;
        const out = new Uint8Array(total);
        let o = 0;
        for (const c of chunks) {
          out.set(c, o);
          o += c.byteLength;
        }
        this.published.set(path, out);
      },
      abort: async () => {
        if (done) return;
        done = true;
        this.stages.delete(path);
      },
    };
  }
}

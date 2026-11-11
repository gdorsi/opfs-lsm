import type { AsyncFs, FileWriter, OpenFile } from "./async-fs.js";
import { levelOfDir } from "../store/levels.js";

/** Calls and bytes for one path class. */
export type IoCount = { calls: number; bytes: number };

/**
 * IO by path class: the first segment of the AsyncFs path ("l0", "l1", …,
 * "m"), else "other". Monotonic; callers diff snapshots.
 */
export type IoCounters = {
  /** Bytes of files that finished. `calls` counts files, not write calls. */
  written: Record<string, IoCount>;
  /** Bytes `read` and open-file reads returned. */
  read: Record<string, IoCount>;
  /** Files `remove` or `removeUnlessOpen` deleted. Bytes when this fs finished the file, else 0. */
  removed: Record<string, IoCount>;
};

function emptyIoCounters(): IoCounters {
  return { written: {}, read: {}, removed: {} };
}

function pathClass(path: string): string {
  const slash = path.indexOf("/");
  const head = slash < 0 ? "" : path.slice(0, slash);
  return head === "m" || levelOfDir(head) !== undefined ? head : "other";
}

function add(into: Record<string, IoCount>, path: string, bytes: number): void {
  const key = pathClass(path);
  const count = into[key] ?? (into[key] = { calls: 0, bytes: 0 });
  count.calls += 1;
  count.bytes += bytes;
}

/**
 * Counts every IO call of `inner` by path class. Integer adds per call,
 * never per key. Also remembers the size of each file it finished, so a
 * later remove knows it without a read.
 */
export class CountingFs implements AsyncFs {
  readonly inner: AsyncFs;
  readonly counters: IoCounters;
  private readonly sizes = new Map<string, number>();

  constructor(inner: AsyncFs, counters: IoCounters = emptyIoCounters()) {
    this.inner = inner;
    this.counters = counters;
  }

  async read(
    path: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array | undefined> {
    const out = await this.inner.read(path, offset, length);
    add(this.counters.read, path, out?.byteLength ?? 0);
    return out;
  }

  async open(path: string): Promise<OpenFile | undefined> {
    const file = await this.inner.open(path);
    if (!file) return undefined;
    return {
      size: file.size,
      read: async (offset: number, length: number) => {
        const out = await file.read(offset, length);
        add(this.counters.read, path, out.byteLength);
        return out;
      },
      close: () => file.close(),
    };
  }

  list(dir: string): Promise<readonly string[]> {
    return this.inner.list(dir);
  }

  async remove(path: string): Promise<void> {
    await this.inner.remove(path);
    add(this.counters.removed, path, this.sizes.get(path) ?? 0);
    this.sizes.delete(path);
  }

  async removeUnlessOpen(path: string): Promise<boolean> {
    const removed = await this.inner.removeUnlessOpen(path);
    if (removed) {
      add(this.counters.removed, path, this.sizes.get(path) ?? 0);
      this.sizes.delete(path);
    }
    return removed;
  }

  async removeAll(): Promise<void> {
    await this.inner.removeAll();
    this.sizes.clear();
  }

  async create(path: string): Promise<FileWriter> {
    const writer = await this.inner.create(path);
    let bytes = 0;
    return {
      write: async (chunk: Uint8Array) => {
        await writer.write(chunk);
        bytes += chunk.byteLength;
      },
      finish: async () => {
        await writer.finish();
        add(this.counters.written, path, bytes);
        this.sizes.set(path, bytes);
      },
      abort: () => writer.abort(),
    };
  }
}

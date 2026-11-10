import type { LogId, RecordN } from "../../src/host/queues.js";
import type { LogLocks } from "../../src/host/queue-host.js";
import type { SegmentFile, SegmentStore } from "../../src/log/queue-writer.js";
import { segmentPath } from "../../src/log/segment.js";
import type { AsyncFs, FileWriter, OpenFile } from "../../src/opfs/async-fs.js";
import { MemoryFs } from "../../src/opfs/memory-fs.js";

/**
 * How a SharedWorker's `getFile()` read of a file that a dedicated
 * WebWorker holds open behaves (docs/research/opfs-worker-probes.md):
 * - chrome: throws `NotReadableError`; removing the file throws too.
 * - safari: a snapshot, here the bytes as of the last flush; removing the
 *   file succeeds and the writer goes on writing to a file no one can see.
 * - firefox: live bytes, which can stop partway through the newest write;
 *   removing the file throws.
 * A closed file reads whole in all three.
 */
export type Browser = "chrome" | "safari" | "firefox";

export const BROWSERS: readonly Browser[] = ["chrome", "safari", "firefox"];

/** For the next write to a log: how many bytes land, and whether the call then throws or returns that short count. */
export type WriteFault = { readonly mode: "throw" | "short"; readonly landed: number };

class HandleFile {
  bytes = new Uint8Array(0);
  flushed = 0;
  /** Where the newest write began. */
  lastWrite = 0;
  open = true;
}

/**
 * One origin's OPFS for a database, in memory: files published with
 * `createWritable` (runs, manifests) in a MemoryFs, and segment files that
 * `segments` creates and writes in place as SyncAccessHandles do. The host
 * reads both through the `AsyncFs` side, with `browser`'s read behavior.
 */
export class QueueFs implements AsyncFs {
  readonly inner = new MemoryFs();
  private readonly handles = new Map<string, HandleFile>();
  private readonly faults = new Map<LogId, WriteFault>();
  /** Paths a remove found open in a writer. */
  readonly removedOpen: string[] = [];
  readonly segments: SegmentStore;

  constructor(
    readonly browser: Browser,
    private readonly random: () => number = Math.random,
  ) {
    this.segments = { create: async (log, firstN) => this.openSegment(log, firstN) };
  }

  /** Fail the next write any writer of `log` makes. */
  failNextWrite(log: LogId, fault: WriteFault): void {
    this.faults.set(log, fault);
  }

  /** The writer of `log` died: the browser closes its handles, flushed or not. */
  closeHandles(log: LogId): void {
    for (const [path, file] of this.handles) if (path.startsWith(`w/${log}/`)) file.open = false;
  }

  private openSegment(log: LogId, firstN: RecordN): SegmentFile {
    const path = segmentPath(log, firstN);
    const file = new HandleFile();
    this.handles.set(path, file);
    return {
      write: (data, at) => {
        if (!file.open) throw new Error(`write to a closed handle: ${path}`);
        const fault = this.faults.get(log);
        this.faults.delete(log);
        const landed = fault ? Math.min(fault.landed, data.byteLength) : data.byteLength;
        if (at + landed > file.bytes.byteLength) {
          const grown = new Uint8Array(at + landed);
          grown.set(file.bytes);
          file.bytes = grown;
        }
        file.bytes.set(data.subarray(0, landed), at);
        file.lastWrite = at;
        if (fault?.mode === "throw") throw new Error(`injected write failure: ${path}`);
        return landed;
      },
      flush: () => {
        if (!file.open) throw new Error(`flush of a closed handle: ${path}`);
        file.flushed = file.bytes.byteLength;
      },
      close: () => {
        file.open = false;
      },
    };
  }

  private view(file: HandleFile): Uint8Array {
    if (!file.open) return file.bytes.slice();
    switch (this.browser) {
      case "chrome":
        throw new DOMException("the file is being written", "NotReadableError");
      case "safari":
        return file.bytes.slice(0, file.flushed);
      case "firefox": {
        const torn = Math.floor(this.random() * (file.bytes.byteLength - file.lastWrite + 1));
        return file.bytes.slice(0, file.lastWrite + torn);
      }
    }
  }

  async read(path: string, offset: number, length: number): Promise<Uint8Array | undefined> {
    const file = this.handles.get(path);
    if (!file) return this.inner.read(path, offset, length);
    return this.view(file).slice(offset, offset + length);
  }

  open(path: string): Promise<OpenFile | undefined> {
    return this.inner.open(path);
  }

  async list(dir: string): Promise<readonly string[]> {
    const names = new Set(await this.inner.list(dir));
    const prefix = `${dir}/`;
    for (const path of this.handles.keys()) if (path.startsWith(prefix)) names.add(path.slice(prefix.length).split("/")[0]!);
    return [...names];
  }

  async remove(path: string): Promise<void> {
    const file = this.handles.get(path);
    if (file) {
      if (file.open) {
        this.removedOpen.push(path);
        if (this.browser !== "safari") throw new DOMException(`${path} is open`, "NoModificationAllowedError");
      }
      this.handles.delete(path);
      return;
    }
    if ((await this.list(path)).length > 0) throw new DOMException(`${path} is not empty`, "InvalidModificationError");
    await this.inner.remove(path);
  }

  removeUnlessOpen(path: string): Promise<boolean> {
    return this.inner.removeUnlessOpen(path);
  }

  create(path: string): Promise<FileWriter> {
    return this.inner.create(path);
  }
}

/**
 * The per-log Web Locks of one origin. Writers hold their logs' locks by
 * name; each host gets a `LogLocks` view, and a host that dies loses every
 * lock it held.
 */
export class TestLocks {
  private readonly holders = new Map<LogId, string>();

  hold(log: LogId, holder: string): void {
    if (this.holders.has(log)) throw new Error(`harness: ${log} is already held by ${this.holders.get(log)}`);
    this.holders.set(log, holder);
  }

  release(log: LogId): void {
    this.holders.delete(log);
  }

  heldBy(log: LogId): string | undefined {
    return this.holders.get(log);
  }

  for(holder: string): LogLocks {
    return {
      take: async (log) => {
        if (this.holders.has(log)) return undefined;
        this.holders.set(log, holder);
        return () => {
          if (this.holders.get(log) === holder) this.holders.delete(log);
        };
      },
    };
  }
}

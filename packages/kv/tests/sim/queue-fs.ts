import type { LogId, RecordN } from "../../src/host/queues.js";
import type { LogLocks } from "../../src/host/queue-host.js";
import type { SegmentFile, SegmentStore } from "../../src/log/queue-writer.js";
import { parseSegmentName, segmentPath } from "../../src/log/segment.js";
import type { AsyncFs, FileWriter, OpenFile } from "../../src/opfs/async-fs.js";
import { MemoryFs } from "../../src/opfs/memory-fs.js";

/**
 * How a SharedWorker's `getFile()` read of a file that a dedicated
 * WebWorker holds open behaves (docs/research/opfs-worker-probes.md):
 * - chrome: throws `NotReadableError` while a write is in flight, and
 *   otherwise returns every whole write; removing the file throws.
 * - safari: a snapshot, here the bytes as of the last flush; removing the
 *   file succeeds and the writer goes on writing to a file no one can see.
 * - firefox: live bytes, which can stop anywhere past the last flush;
 *   removing the file throws.
 * A closed file reads whole in all three.
 */
export type Browser = "chrome" | "safari" | "firefox";

export const BROWSERS: readonly Browser[] = ["chrome", "safari", "firefox"];

/**
 * For a log's segment write after `skip` more: how many bytes land, and
 * whether the call then throws or returns that short count. Or its next
 * segment create throws.
 */
export type Fault =
  | { readonly at: "write"; readonly mode: "throw" | "short"; readonly landed: number; readonly skip?: number }
  | { readonly at: "create" };

class HandleFile {
  bytes = new Uint8Array(0);
  flushed = 0;
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
  private readonly faults = new Map<LogId, Fault>();
  private readonly stages = new Set<FileWriter>();
  /** Segments a remove found open in a writer with no later segment in their log: a live log's last segment. */
  readonly removedLast: string[] = [];
  readonly segments: SegmentStore;

  constructor(
    readonly browser: Browser,
    /** Where a firefox read of an open file stops, and whether chrome refuses one. */
    public random: () => number = Math.random,
    /** The share of chrome reads of an open file that meet a write in flight. 1: a burst that never lets up. */
    private readonly chromeRefusal = 1,
  ) {
    this.segments = {
      create: async (log, firstN) => {
        if (this.faults.get(log)?.at === "create") {
          this.faults.delete(log);
          throw new Error(`injected create failure: ${segmentPath(log, firstN)}`);
        }
        return this.openSegment(log, firstN);
      },
    };
  }

  /** Make the next write or create of `log`'s writer fail, until `disarm`. */
  fail(log: LogId, fault: Fault): void {
    this.faults.set(log, fault);
  }

  disarm(log: LogId): void {
    this.faults.delete(log);
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
        let fault = this.faults.get(log);
        if (fault?.at === "write" && fault.skip) {
          this.faults.set(log, { ...fault, skip: fault.skip - 1 });
          fault = undefined;
        }
        if (fault?.at === "write") this.faults.delete(log);
        const landed = fault?.at === "write" ? Math.min(fault.landed, data.byteLength) : data.byteLength;
        if (at + landed > file.bytes.byteLength) {
          const grown = new Uint8Array(at + landed);
          grown.set(file.bytes);
          file.bytes = grown;
        }
        file.bytes.set(data.subarray(0, landed), at);
        if (fault?.at === "write" && fault.mode === "throw") throw new Error(`injected write failure: ${path}`);
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
        if (this.random() < this.chromeRefusal) throw new DOMException("the file is being written", "NotReadableError");
        return file.bytes.slice();
      case "safari":
        return file.bytes.slice(0, file.flushed);
      case "firefox":
        return file.bytes.slice(0, file.flushed + Math.floor(this.random() * (file.bytes.byteLength - file.flushed + 1)));
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
        if (!this.hasLater(path)) this.removedLast.push(path);
        if (this.browser !== "safari") throw new DOMException(`${path} is open`, "NoModificationAllowedError");
      }
      this.handles.delete(path);
      return;
    }
    const inside = `${path}/`;
    if ([...this.inner.publishedPaths(), ...this.handles.keys()].some((p) => p.startsWith(inside))) {
      throw new DOMException(`${path} is not empty`, "InvalidModificationError");
    }
    await this.inner.remove(path);
  }

  private hasLater(path: string): boolean {
    const dir = path.slice(0, path.lastIndexOf("/") + 1);
    const firstN = parseSegmentName(path.slice(dir.length))!;
    return [...this.handles.keys()].some((p) => p.startsWith(dir) && parseSegmentName(p.slice(dir.length))! > firstN);
  }

  removeUnlessOpen(path: string): Promise<boolean> {
    return this.inner.removeUnlessOpen(path);
  }

  async create(path: string): Promise<FileWriter> {
    const w = await this.inner.create(path);
    this.stages.add(w);
    const done = () => this.stages.delete(w);
    return {
      write: (bytes) => w.write(bytes),
      finish: () => w.finish().finally(done),
      abort: () => w.abort().finally(done),
    };
  }

  /** The SharedWorker died: the browser drops the writables it left unclosed. */
  async dropStages(): Promise<void> {
    for (const w of this.stages) await w.abort();
    this.stages.clear();
  }

  /** Every file's path, taken in one step. */
  paths(): string[] {
    return [...this.inner.publishedPaths(), ...this.handles.keys()];
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

  releaseAll(holder: string): void {
    for (const [log, h] of this.holders) if (h === holder) this.holders.delete(log);
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

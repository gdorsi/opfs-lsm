import { MemoryFs } from "../../src/index.js";
import type { SegmentStore } from "../../src/log/queue-writer.js";
import { segmentPath } from "../../src/log/segment.js";
import type { AsyncFs, FileWriter } from "../../src/opfs/async-fs.js";

/**
 * Fault injection for OPFS (docs/research/corruption-hardening-test-suite.md,
 * technique 3). `Faults` is shared by a `FaultFs` and `traceSegments`, so
 * the durable ops of the run files, manifests and log segments land in one
 * numbered trace, and one fault plan counts the attempts of all of them.
 *
 * Durable ops, each atomic (design.md, "Assumptions about the platform"):
 * - touch: `create` of a path that does not exist makes an empty file at
 *   once, as BrowserFs's `getFileHandle(path, { create: true })` does
 *   before `createWritable`, and as a segment's create does;
 * - publish: `create` → `write`… → `finish` (createWritable → close),
 *   recorded at `finish` with the whole file;
 * - remove: `remove`, or `removeUnlessOpen` that removed;
 * - segment write: a SyncAccessHandle `write` of bytes at an offset, which
 *   a process crash keeps once it returned.
 *
 * A crash state is rebuilt from a prefix of the trace (`materializeFs`),
 * the way ALICE and RocksDB's FaultInjectionTestFS do it: the engine keeps
 * nothing durable but these ops, so the files after a crash at op k are the
 * ops before k applied to an empty directory.
 */

export type DurableOp =
  | { readonly i: number; readonly kind: "publish"; readonly path: string; readonly bytes: Uint8Array }
  | { readonly i: number; readonly kind: "touch" | "remove"; readonly path: string }
  | { readonly i: number; readonly kind: "segment"; readonly path: string; readonly at: number; readonly bytes: Uint8Array };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A durable op in a failure message. */
export function describeOp(op: DurableOp): string {
  return op.kind === "segment" ? `#${op.i} segment ${op.path} @${op.at}+${op.bytes.byteLength}` : `#${op.i} ${op.kind} ${op.path}`;
}

/** A fault site: one fs call, or one segment write or create. */
export type SiteKind = "fs-read" | "fs-write" | "segment-write";

class InjectedIoError extends Error {
  override name = "InjectedIoError";
}

export class Faults {
  /** Durable ops in the order they completed. */
  readonly ops: DurableOp[] = [];
  /** Fault sites reached, in order. Site n is `sites[n - 1]`. */
  readonly sites: string[] = [];
  /** Sites of these kinds count; the others pass untouched. */
  kinds: ReadonlySet<SiteKind> = new Set<SiteKind>(["fs-read", "fs-write", "segment-write"]);
  /** Sites this matches are not sites: they never fail and are not counted. */
  spare: ((label: string) => boolean) | undefined;
  /** Fail site `failAt` (1-based), and with `persistent` every later site too. */
  failAt: number | undefined;
  persistent = false;
  /** How many sites a fault was injected at. */
  injected = 0;
  /**
   * Process crash: once `crashAfter` durable ops completed, every later fs
   * call never settles and every later segment write throws, so nothing
   * after the crash point becomes durable.
   */
  crashAfter: number | undefined;
  /** Resolves when the crash point is reached. */
  readonly crashed: Promise<void>;
  private onCrash!: () => void;
  isCrashed = false;

  constructor() {
    this.crashed = new Promise<void>((resolve) => (this.onCrash = resolve));
  }

  /** Called at each site. "fail" injects an error, "crash" freezes. */
  hit(kind: SiteKind, label: string): "ok" | "fail" | "crash" {
    if (this.isCrashed) return "crash";
    if (!this.kinds.has(kind) || this.spare?.(label)) return "ok";
    this.sites.push(label);
    const n = this.sites.length;
    if (this.failAt !== undefined && (n === this.failAt || (this.persistent && n > this.failAt))) {
      this.injected++;
      return "fail";
    }
    return "ok";
  }

  /** Stop injecting. The stores keep whatever the faults left. */
  heal(): void {
    this.failAt = undefined;
    this.persistent = false;
  }

  record(op: DistributiveOmit<DurableOp, "i">): void {
    if (this.isCrashed) throw new Error(`harness: a durable op completed after the crash (${describeOp({ ...op, i: 0 } as DurableOp)})`);
    this.ops.push({ ...op, i: this.ops.length + 1 } as DurableOp);
    if (this.crashAfter !== undefined && this.ops.length >= this.crashAfter) this.crash();
  }

  /** Crash now: nothing more becomes durable. */
  crash(): void {
    this.isCrashed = true;
    this.onCrash();
  }
}

const never = <T>() => new Promise<T>(() => undefined);

/** An `AsyncFs` over `inner` that traces durable ops and injects `faults`. */
export class FaultFs implements AsyncFs {
  constructor(
    readonly inner: AsyncFs,
    private readonly faults: Faults,
  ) {}

  /** Throws, never settles, or runs `fn`, per the fault plan. */
  private async site<T>(kind: SiteKind, label: string, fn: () => Promise<T>): Promise<T> {
    const verdict = this.faults.hit(kind, label);
    if (verdict === "crash") return never();
    if (verdict === "fail") throw new InjectedIoError(`injected I/O error at ${label}`);
    return fn();
  }

  read(path: string, offset: number, length: number) {
    return this.site("fs-read", `read ${path}`, () => this.inner.read(path, offset, length));
  }

  open(path: string) {
    return this.site("fs-read", `open ${path}`, async () => {
      const file = await this.inner.open(path);
      if (!file) return undefined;
      return {
        size: file.size,
        read: (offset: number, length: number) =>
          this.site("fs-read", `read page ${path}`, () => file.read(offset, length)),
        close: () => file.close(),
      };
    });
  }

  list(dir: string) {
    return this.site("fs-read", `list ${dir || "/"}`, () => this.inner.list(dir));
  }

  remove(path: string) {
    return this.site("fs-write", `remove ${path}`, async () => {
      await this.inner.remove(path);
      this.faults.record({ kind: "remove", path });
    });
  }

  removeUnlessOpen(path: string) {
    return this.site("fs-write", `remove ${path}`, async () => {
      const removed = await this.inner.removeUnlessOpen(path);
      if (removed) this.faults.record({ kind: "remove", path });
      return removed;
    });
  }

  create(path: string): Promise<FileWriter> {
    return this.site("fs-write", `create ${path}`, async () => {
      if ((await this.inner.read(path, 0, 0)) === undefined) {
        const empty = await this.inner.create(path);
        await empty.finish();
        this.faults.record({ kind: "touch", path });
      }
      const w = await this.inner.create(path);
      const chunks: Uint8Array[] = [];
      // The engine does not abort a writer whose write or close failed.
      // Abort the inner stage, so MemoryFs lets the path be created again,
      // as OPFS does. A failed close leaves the target untouched (fs.spec).
      const aborting = async (err: unknown): Promise<never> => {
        if (err instanceof InjectedIoError) await w.abort();
        throw err;
      };
      return {
        write: (bytes: Uint8Array) =>
          this.site("fs-write", `write ${path}`, async () => {
            await w.write(bytes);
            chunks.push(new Uint8Array(bytes));
          }).catch(aborting),
        finish: () =>
          this.site("fs-write", `close ${path}`, async () => {
            await w.finish();
            this.faults.record({ kind: "publish", path, bytes: concat(chunks) });
          }).catch(aborting),
        abort: () => w.abort(),
      };
    });
  }
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * `inner`'s segments with every create and write traced as a durable op,
 * and each write a fault site. A crashed store's create never settles and
 * its writes throw, as a killed dedicated WebWorker's would never return.
 */
export function traceSegments(inner: SegmentStore, faults: Faults): SegmentStore {
  return {
    create: async (log, firstN) => {
      const path = segmentPath(log, firstN);
      const verdict = faults.hit("segment-write", `create ${path}`);
      if (verdict === "crash") return never();
      if (verdict === "fail") throw new InjectedIoError(`injected I/O error at create ${path}`);
      const file = await inner.create(log, firstN);
      faults.record({ kind: "touch", path });
      return {
        write: (bytes, at) => {
          const v = faults.hit("segment-write", `write ${path}`);
          if (v === "crash") throw new InjectedIoError(`write ${path} after the crash`);
          if (v === "fail") throw new InjectedIoError(`injected I/O error at write ${path}`);
          const n = file.write(bytes, at);
          faults.record({ kind: "segment", path, at, bytes: new Uint8Array(bytes.subarray(0, n)) });
          return n;
        },
        flush: () => file.flush(),
        close: () => file.close(),
      };
    },
  };
}

/** A MemoryFs holding the first `count` ops of `ops`. */
export async function materializeFs(ops: readonly DurableOp[], count: number): Promise<MemoryFs> {
  const fs = new MemoryFs();
  for (const op of ops.slice(0, count)) {
    if (op.kind === "remove") {
      await fs.remove(op.path);
      continue;
    }
    const had = await fs.read(op.path, 0, Number.POSITIVE_INFINITY);
    if (op.kind === "touch" && had !== undefined) continue;
    let bytes: Uint8Array = new Uint8Array(0);
    if (op.kind === "publish") bytes = op.bytes;
    if (op.kind === "segment") {
      bytes = new Uint8Array(Math.max(had?.byteLength ?? 0, op.at + op.bytes.byteLength));
      if (had) bytes.set(had);
      bytes.set(op.bytes, op.at);
    }
    const w = await fs.create(op.path);
    await w.write(bytes);
    await w.finish();
  }
  return fs;
}

/** Every published file of `fs`, for comparing stores. */
export async function fsFiles(fs: MemoryFs): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  for (const path of fs.publishedPaths()) out.set(path, (await fs.read(path, 0, Number.POSITIVE_INFINITY))!);
  return out;
}

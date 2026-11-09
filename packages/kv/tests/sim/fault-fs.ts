import type { SegmentFile, SegmentStore } from "../../src/log/tab-writer.js";
import type { AsyncFs, FileWriter } from "../../src/opfs/async-fs.js";
import { MemoryFs } from "../../src/index.js";

/**
 * Fault injection for the database's files (docs/research/corruption-hardening-test-suite.md,
 * technique 3). `Faults` numbers the durable ops of a `FaultFs` in one
 * trace, and one fault plan counts its call sites.
 *
 * Durable ops, each atomic (design.md, "Assumptions about the platform"):
 * - OPFS touch: `create` of a path that does not exist makes an empty file
 *   at once, as BrowserFs's `getFileHandle(path, { create: true })` does
 *   before `createWritable`;
 * - OPFS publish: `create` → `write`… → `finish` (createWritable → close),
 *   recorded at `finish` with the whole file;
 * - OPFS remove: `remove`, or `removeUnlessOpen` that removed;
 * - log create, write and flush: a tab's segment file (a SyncAccessHandle
 *   in the browser) made, written in place at an offset, and flushed.
 *
 * A crash state is rebuilt from the trace (`materializeFs`), the way ALICE
 * and RocksDB's FaultInjectionTestFS do it: the engine keeps nothing
 * durable but these ops, so the files after a crash are a choice of them
 * applied to an empty directory, in order.
 */

export type DurableOp = { readonly i: number; readonly label: string } & (
  | { readonly store: "opfs"; readonly kind: "publish"; readonly path: string; readonly bytes: Uint8Array }
  | { readonly store: "opfs"; readonly kind: "touch" | "remove"; readonly path: string }
  | { readonly store: "log"; readonly kind: "create" | "flush"; readonly path: string }
  | { readonly store: "log"; readonly kind: "write"; readonly path: string; readonly at: number; readonly bytes: Uint8Array }
);

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A durable op in a failure message. Tab ids and stamps are aliased, so two runs of one workload describe alike. */
export function describeOp(op: DurableOp): string {
  return `#${op.i} ${op.label}`;
}

/** A fault site: one fs call, or one call on a log segment. */
export type SiteKind = "fs-read" | "fs-write" | "log-write";

class InjectedIoError extends Error {
  override name = "InjectedIoError";
}

export class Faults {
  /** Durable ops in the order they completed. */
  readonly ops: DurableOp[] = [];
  /** Fault sites reached, in order. Site n is `sites[n - 1]`. */
  readonly sites: string[] = [];
  /** Sites of these kinds count; the others pass untouched. */
  kinds: ReadonlySet<SiteKind> = new Set<SiteKind>(["fs-read", "fs-write", "log-write"]);
  /** Sites this matches are not sites: they never fail and are not counted. */
  spare: ((label: string) => boolean) | undefined;
  /** Fail site `failAt` (1-based), and with `persistent` every later site too. */
  failAt: number | undefined;
  persistent = false;
  /** How many sites a fault was injected at. */
  injected = 0;
  /**
   * Process crash: once `crashAfter` durable ops completed, every later fs
   * call never settles and every later log write is dropped and never
   * settles, so nothing after the crash point becomes durable.
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

  private readonly tabs = new Map<string, string>();

  /** `path` with tab ids as t1, t2… in order of appearance, and segment names without their stamp. */
  alias(path: string): string {
    return path
      .replace(/^(.*\/\d{10})\.\d{16}\.wal$/, "$1.wal")
      .replace(/^w\/([0-9a-f]{16})/, (_m, tab: string) => {
        let a = this.tabs.get(tab);
        if (!a) this.tabs.set(tab, (a = `t${this.tabs.size + 1}`));
        return `w/${a}`;
      });
  }

  record(op: DistributiveOmit<DurableOp, "i" | "label">): void {
    const extra = op.kind === "write" ? ` @${op.at} +${op.bytes.byteLength}` : "";
    const label = `${op.store} ${op.kind} ${this.alias(op.path)}${extra}`;
    if (this.isCrashed) throw new Error(`harness: a durable op completed after the crash (${label})`);
    this.ops.push({ ...op, label, i: this.ops.length + 1 } as DurableOp);
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
      this.faults.record({ store: "opfs", kind: "remove", path });
    });
  }

  removeUnlessOpen(path: string) {
    return this.site("fs-write", `remove ${path}`, async () => {
      const removed = await this.inner.removeUnlessOpen(path);
      if (removed) this.faults.record({ store: "opfs", kind: "remove", path });
      return removed;
    });
  }

  /**
   * The inner fs's log segments, traced. Segment calls are synchronous, as
   * on a SyncAccessHandle: a fault throws, and after a crash a write is
   * dropped and its `settled` never settles.
   */
  segments(): SegmentStore {
    const inner = this.inner.segments?.();
    if (!inner) throw new Error("harness: FaultFs needs an inner fs with segments");
    const faults = this.faults;
    return {
      create: (path) =>
        this.site("log-write", `create ${path}`, async () => {
          const file = await inner.create(path);
          faults.record({ store: "log", kind: "create", path });
          let dropped = false;
          return {
            write(bytes, at) {
              const verdict = faults.hit("log-write", `write ${path}`);
              if (verdict === "fail") throw new InjectedIoError(`injected I/O error at write ${path}`);
              if (verdict === "crash") {
                dropped = true;
                return bytes.byteLength;
              }
              const n = file.write(bytes, at);
              faults.record({ store: "log", kind: "write", path, at, bytes: new Uint8Array(bytes) });
              return n;
            },
            flush() {
              const verdict = faults.hit("log-write", `flush ${path}`);
              if (verdict === "fail") throw new InjectedIoError(`injected I/O error at flush ${path}`);
              if (verdict === "crash") return;
              file.flush();
              faults.record({ store: "log", kind: "flush", path });
            },
            getSize: () => file.getSize(),
            close: () => file.close(),
            settled: () => (dropped ? never<void>() : Promise.resolve()),
          } satisfies SegmentFile;
        }),
    };
  }

  create(path: string): Promise<FileWriter> {
    return this.site("fs-write", `create ${path}`, async () => {
      if ((await this.inner.read(path, 0, 0)) === undefined) {
        const empty = await this.inner.create(path);
        await empty.finish();
        this.faults.record({ store: "opfs", kind: "touch", path });
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
            this.faults.record({ store: "opfs", kind: "publish", path, bytes: concat(chunks) });
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

/** `fs` (a new MemoryFs by default) holding the ops of `ops` that `keep` keeps (all by default), applied in order. */
export async function materializeFs(
  ops: readonly DurableOp[],
  keep: (op: DurableOp) => boolean = () => true,
  fs = new MemoryFs(),
): Promise<MemoryFs> {
  const segs = fs.segments();
  const files = new Map<string, SegmentFile>();
  const segment = async (path: string) => {
    let file = files.get(path);
    if (!file || (await fs.read(path, 0, 0)) === undefined) files.set(path, (file = await segs.create(path)));
    return file;
  };
  for (const op of ops) {
    if (!keep(op)) continue;
    if (op.store === "log") {
      const file = await segment(op.path);
      if (op.kind === "write") file.write(op.bytes, op.at);
    } else if (op.kind === "remove") {
      await fs.remove(op.path);
    } else if (op.kind === "publish" || (await fs.read(op.path, 0, 0)) === undefined) {
      const w = await fs.create(op.path);
      if (op.kind === "publish") await w.write(op.bytes);
      await w.finish();
    }
  }
  return fs;
}

/** Every published file of `fs`, for comparing stores. */
export async function fsFiles(fs: MemoryFs): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  for (const path of fs.publishedPaths()) out.set(path, (await fs.read(path, 0, Number.POSITIVE_INFINITY))!);
  return out;
}

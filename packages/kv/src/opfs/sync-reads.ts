import type { DbName } from "../check.js";
import type { OpenFile, ReadFs, SyncReadCount, SyncReads } from "./async-fs.js";
import { BrowserReadFs, openBrowserReadFs } from "./browser-fs.js";
import {
  CONTROL_BYTES,
  DATA_BYTES,
  DONE,
  FILE,
  LEN,
  OFF_HI,
  OFF_LO,
  REQ,
  STATUS,
  WAKE,
  type FromWorker,
  type ToWorker,
} from "./sync-read-protocol.js";

/**
 * `@opfs-lsm/kv/sync-reads`: the tab side of `OpenOptions.syncReads`, which
 * only an app that imports this entry bundles. One dedicated worker per page
 * holds a read-only sync access handle on each open run file, for every
 * database opened with the option. The tab asks for a read in a
 * SharedArrayBuffer and spins until the bytes are there
 * (sync-read-protocol), so a read of a page that is not cached returns in
 * the same task. Chromium only: no other browser opens a sync access handle
 * read-only.
 */

/** A run file the worker holds a handle on, or is opening one for. */
type SyncFile = {
  /**
   * The open of the handle, while it is in flight and worth a read's wait:
   * once it resolves the file is ready, or the read goes the async way.
   * Undefined otherwise. Never rejects.
   */
  opening(): Promise<void> | undefined;
  /** Whether `read` answers now. */
  ready(): boolean;
  /** The bytes, or undefined when this read has to go the async way. */
  read(offset: number, length: number): Uint8Array | undefined;
  /** Resolves once the worker closed its handle. Idempotent, and never rejects. */
  close(): Promise<void>;
};

/** The sync files of one open of a database. */
type SyncFiles = {
  /** Undefined once `quiesce` ran, or when the page's reader takes no new file. */
  open(path: string): SyncFile | undefined;
  /**
   * Stops sync reads for good: no file is ready any more, and `open` makes
   * no handle. Resolves once the worker closed every handle it had.
   * Idempotent, and never rejects.
   */
  quiesce(): Promise<void>;
  /** What the files served so far, or undefined while the page's reader is not serving. */
  served(): SyncReadCount | undefined;
};

type Link = {
  readonly worker: Worker;
  readonly ctl: Int32Array;
  readonly data: Uint8Array;
  /** Resolves `GIVE_UP_MS` after the worker was started. */
  readonly patience: Promise<void>;
};

/**
 * The page's reader. It only moves down this list, and `draining` and `off`
 * last for the life of the page.
 * - `starting`: the worker has not said yet whether it can serve. Files are
 *   opened meanwhile, and a read waits for its file.
 * - `slow`: as `starting`, for longer than `GIVE_UP_MS`, as when the
 *   worker's script comes over a slow network. No read waits for it.
 * - `on`: reads go through the buffer.
 * - `draining`: a read timed out. The worker may still answer it, so the
 *   buffer is never read again. The worker stays, to close its handles.
 * - `off`: no worker.
 */
type Reader = { readonly kind: "starting" | "slow" | "on" | "draining"; readonly link: Link } | { readonly kind: "off" };

const OFF: Reader = { kind: "off" };
/** How long the tab waits for the worker before it reads the async way: for the answer to a read, and for a worker that has not started to serve. */
const GIVE_UP_MS = 20;
/** Loads of `DONE` between two looks at the clock. */
const CLOCK_EVERY = 1024;

let reader: Reader | undefined;
/** What waits for the worker's answer to an `open` or a `close`, by message id. */
const replies = new Map<number, (ok: boolean) => void>();
let nextMessage = 0;
let nextFile = 1;
let request = 0;

function start(): Reader {
  if (typeof SharedArrayBuffer === "undefined" || typeof Worker === "undefined") return OFF;
  let worker: Worker | undefined;
  try {
    const buffer = new SharedArrayBuffer(CONTROL_BYTES + DATA_BYTES);
    // The URL stays inline in the constructor, for the reason `workerIngest` gives.
    worker = new Worker(new URL("./sync-read-worker.js", import.meta.url), { type: "module", name: "opfs-lsm-sync-reads" });
    worker.onmessage = ({ data: m }: MessageEvent<FromWorker>) => {
      if (m.kind === "done") {
        replies.get(m.id)?.(m.ok);
        replies.delete(m.id);
      } else if (!m.supported) turnOff();
      else if (reader?.kind === "starting" || reader?.kind === "slow") reader = { kind: "on", link: reader.link };
    };
    worker.onerror = worker.onmessageerror = turnOff;
    worker.postMessage({ kind: "init", buffer } satisfies ToWorker);
    const patience = new Promise<void>((resolve) =>
      setTimeout(() => {
        if (reader?.kind === "starting") reader = { kind: "slow", link: reader.link };
        resolve();
      }, GIVE_UP_MS),
    );
    return { kind: "starting", link: { worker, ctl: new Int32Array(buffer, 0, CONTROL_BYTES / 4), data: new Uint8Array(buffer, CONTROL_BYTES), patience } };
  } catch {
    // No worker here, or a buffer that cannot be posted to it.
    worker?.terminate();
    return OFF;
  }
}

/** Ends the worker, which lets go of its handles, and every wait for one of its answers. */
function turnOff(): void {
  if (reader && reader.kind !== "off") reader.link.worker.terminate();
  reader = OFF;
  for (const resolve of replies.values()) resolve(false);
  replies.clear();
}

/** Resolves with the worker's answer, or false when there is no worker to ask. */
function call(message: { kind: "open"; file: number; folder: string; name: string } | { kind: "close"; file: number }): Promise<boolean> {
  const to = reader;
  if (!to || to.kind === "off") return Promise.resolve(false);
  return new Promise((resolve) => {
    const id = nextMessage++;
    replies.set(id, resolve);
    to.link.worker.postMessage({ ...message, id } satisfies ToWorker);
  });
}

/** The worker's link while it takes a new file. */
function link(): Link | undefined {
  return reader && reader.kind !== "draining" && reader.kind !== "off" ? reader.link : undefined;
}

function openFile({ ctl, data, patience }: Link, folder: string, name: string, count: SyncReadCount, closed: () => void): SyncFile {
  const file = nextFile++;
  /** `open` while the worker holds the handle. A file it could not open goes straight to `closed`. */
  let state: "opening" | "open" | "closed" = "opening";
  const opened = call({ kind: "open", file, folder, name }).then((ok) => {
    state = ok ? "open" : "closed";
  });
  const openedSoon = Promise.race([opened, patience]);
  let closing: Promise<void> | undefined;
  const ready = () => state === "open" && reader?.kind === "on";
  return {
    opening: () => (state !== "opening" ? undefined : reader?.kind === "on" ? opened : reader?.kind === "starting" ? openedSoon : undefined),
    ready,
    read(offset, length) {
      if (!ready() || length > DATA_BYTES) return undefined;
      ctl[FILE] = file;
      // A slot keeps the low 32 bits of the integer part of what is stored in it.
      ctl[OFF_LO] = offset;
      ctl[OFF_HI] = offset / 0x1_0000_0000;
      ctl[LEN] = length;
      request = (request + 1) | 0;
      Atomics.store(ctl, REQ, request);
      Atomics.add(ctl, WAKE, 1);
      Atomics.notify(ctl, WAKE);
      for (let loads = 1, deadline = 0; Atomics.load(ctl, DONE) !== request; loads++) {
        if (loads % CLOCK_EVERY !== 0) continue;
        const now = performance.now();
        if (deadline === 0) deadline = now + GIVE_UP_MS;
        else if (now > deadline) {
          if (reader?.kind === "on") reader = { kind: "draining", link: reader.link };
          return undefined;
        }
      }
      if (ctl[STATUS] !== length) return undefined;
      count.reads++;
      count.bytes += length;
      return data.slice(0, length);
    },
    close: () =>
      (closing ??= opened.then(() => {
        const held = state === "open";
        state = "closed";
        closed();
        return held ? call({ kind: "close", file }).then(() => undefined) : undefined;
      })),
  };
}

/**
 * The sync files of one open of `dbName`, from the page's reader, which the
 * first call starts. Undefined when the page cannot have a reader, or has
 * one that takes no new file.
 */
function syncFiles(dbName: DbName): SyncFiles | undefined {
  reader ??= start();
  if (!link()) return undefined;
  const files = new Set<SyncFile>();
  const count: SyncReadCount = { reads: 0, bytes: 0 };
  let quiesced: Promise<void> | undefined;
  return {
    open(path) {
      const to = link();
      if (quiesced || !to) return undefined;
      const parts = path.split("/").filter((part) => part.length > 0 && part !== ".");
      const name = parts.pop()!;
      const file = openFile(to, ["opfs-lsm", dbName, ...parts].join("/"), name, count, () => files.delete(file));
      files.add(file);
      return file;
    },
    quiesce: () => (quiesced ??= Promise.all([...files].map((file) => file.close())).then(() => undefined)),
    served: () => (reader?.kind === "on" ? { ...count } : undefined),
  };
}

/**
 * A tab's read fs whose run files the page's worker opens too. A file is
 * asked of the worker once the base open holds its lock and found it: a
 * handle on a file with no lock could fail the host's remove.
 */
class SyncReadFs extends BrowserReadFs {
  constructor(
    root: Promise<FileSystemDirectoryHandle>,
    dbName: DbName,
    private readonly files: SyncFiles,
  ) {
    super(root, dbName);
  }

  override async open(path: string): Promise<OpenFile | undefined> {
    const file = await super.open(path);
    const sync = file && this.files.open(path);
    if (!file || !sync) return file;
    return {
      size: file.size,
      read: async (offset, length) => {
        // The first reads after an open wait for the handle once, and not for one async read each.
        const opening = sync.opening();
        if (opening) await opening;
        return sync.read(offset, length) ?? file.read(offset, length);
      },
      readSync: sync.read,
      syncReady: sync.ready,
      // The worker's handle closes before the lock goes: a file with a handle open cannot be removed.
      close: () => void sync.close().then(() => file.close()),
    };
  }

  quiesce(): Promise<void> {
    return this.files.quiesce();
  }

  syncReads(): SyncReadCount | undefined {
    return this.files.served();
  }
}

/** Pass it as `OpenOptions.syncReads`. */
export const syncReads = {
  readFs(name: DbName, parent: Promise<FileSystemDirectoryHandle>): ReadFs {
    const files = syncFiles(name);
    if (!files) return openBrowserReadFs(name, parent);
    // As `openBrowserReadFs` finds the folder.
    const root = parent.then((lsm) => lsm.getDirectoryHandle(name, { create: true }));
    root.catch(() => undefined);
    return new SyncReadFs(root, name, files);
  },
} as SyncReads;

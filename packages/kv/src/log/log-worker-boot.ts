import { checkDbName, type DbName } from "../check.js";
import type { LogId, PredEdge, RecordN } from "../host/queues.js";
import { QueueWriter, type SegmentStore } from "./queue-writer.js";
import { segmentPath } from "./segment.js";

/** Page to dedicated WebWorker, without the request id. Private to this module and `client.ts`. */
export type LogCommand =
  | { readonly t: "open"; readonly db: DbName; readonly log: LogId; readonly segmentBytes: number; readonly pred?: PredEdge }
  | { readonly t: "append"; readonly bodies: readonly Uint8Array[] }
  | { readonly t: "flush" | "rotate" | "close" };

export type PageToLog = LogCommand & { readonly id: number };

/** Dedicated WebWorker to page, one per request, in request order. `n` is the log's last acked record. */
export type LogToPage =
  | { readonly t: "done"; readonly id: number; readonly n: RecordN }
  | { readonly t: "failed"; readonly id: number; readonly message: string };

/** Held by the dedicated WebWorker that writes `w/<log>/` for its whole life: free means no write of it can land any more. */
export function logLockName(db: DbName, log: LogId): string {
  return `opfs-lsm-log/${db}/${log}`;
}

/** What the message loop needs of the dedicated WebWorker it runs in. */
export type LogWorkerScope = {
  /** Takes the Web Lock `name` if it is free and resolves with its release, or with undefined when another context holds it. */
  lock(name: string): Promise<(() => void) | undefined>;
  segments(db: DbName): Promise<SegmentStore>;
  post(msg: LogToPage): void;
  exit(): void;
};

/**
 * The message loop of one log. The lock is taken before the log's first
 * segment creates `w/<log>/`, so a log directory always had its lock
 * granted. `close` closes the writer, releases the lock and ends the
 * dedicated WebWorker by itself, so a page frozen right after asking still
 * frees both.
 */
export function serveLog(scope: LogWorkerScope): (data: unknown) => void {
  let writer: Promise<QueueWriter> = Promise.reject(new Error("log not open"));
  writer.catch(() => undefined);
  let release: (() => void) | undefined;

  const open = async (msg: Extract<LogCommand, { t: "open" }>): Promise<QueueWriter> => {
    release = await scope.lock(logLockName(msg.db, msg.log));
    if (!release) throw new Error(`log ${msg.log} is locked by another context`);
    const store = await scope.segments(msg.db);
    return QueueWriter.open(store, msg.log, msg.pred ? { segmentBytes: msg.segmentBytes, pred: msg.pred } : { segmentBytes: msg.segmentBytes });
  };

  const reply = (id: number, result: Promise<RecordN>): Promise<void> =>
    result.then(
      (n) => scope.post({ t: "done", id, n }),
      (err: unknown) => scope.post({ t: "failed", id, message: err instanceof Error ? err.message : String(err) }),
    );

  return (data) => {
    const msg = parsePageToLog(data);
    if (!msg) return;
    switch (msg.t) {
      case "open":
        writer = open(msg);
        void reply(msg.id, writer.then((w) => w.lastAcked));
        return;
      case "append":
        void reply(msg.id, writer.then((w) => w.append(msg.bodies)));
        return;
      case "flush":
        void reply(msg.id, writer.then((w) => w.flush()));
        return;
      case "rotate":
        void reply(
          msg.id,
          writer.then(async (w) => {
            await w.rotate();
            return w.lastAcked;
          }),
        );
        return;
      case "close":
        void reply(
          msg.id,
          writer.then(async (w) => {
            await w.close();
            return w.lastAcked;
          }),
        ).finally(() => {
          release?.();
          scope.exit();
        });
        return;
    }
  };
}

const LOG_ID = /^(?!0{16})[0-9a-f]{16}$/;
const isId = (v: unknown): v is number => Number.isSafeInteger(v);
const isN = (v: unknown): v is RecordN => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 0xffff_ffff;

function parsePred(v: unknown): PredEdge | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const { log, lastN } = v as Record<string, unknown>;
  return typeof log === "string" && LOG_ID.test(log) && isN(lastN) ? { log: log as LogId, lastN } : undefined;
}

function parseDbName(v: string): DbName | undefined {
  try {
    return checkDbName(v);
  } catch {
    return undefined;
  }
}

function parsePageToLog(data: unknown): PageToLog | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const m = data as Record<string, unknown>;
  if (!isId(m.id)) return undefined;
  const id = m.id;
  switch (m.t) {
    case "open": {
      if (typeof m.db !== "string" || typeof m.log !== "string" || !LOG_ID.test(m.log)) return undefined;
      if (!Number.isInteger(m.segmentBytes) || (m.segmentBytes as number) <= 0) return undefined;
      const pred = parsePred(m.pred);
      if (m.pred !== undefined && !pred) return undefined;
      const db = parseDbName(m.db);
      if (!db) return undefined;
      const base = { t: "open", id, db, log: m.log as LogId, segmentBytes: m.segmentBytes as number } as const;
      return pred ? { ...base, pred } : base;
    }
    case "append":
      return Array.isArray(m.bodies) && m.bodies.every((b) => b instanceof Uint8Array) ? { t: "append", id, bodies: m.bodies as Uint8Array[] } : undefined;
    case "flush":
    case "rotate":
    case "close":
      return { t: m.t, id };
    default:
      return undefined;
  }
}

/** The SyncAccessHandle calls a segment needs. The DOM lib this package builds against does not declare them. */
type SyncHandle = {
  write(bytes: Uint8Array, options: { at: number }): number;
  flush(): void;
  close(): void;
};

/** Segments under `opfs-lsm/<db>/`, the directory `openBrowserFs` uses. */
async function opfsSegments(db: DbName): Promise<SegmentStore> {
  const root = await navigator.storage.getDirectory();
  const dbDir = await (await root.getDirectoryHandle("opfs-lsm", { create: true })).getDirectoryHandle(db, { create: true });
  return {
    async create(log, firstN) {
      const parts = segmentPath(log, firstN).split("/");
      let dir = dbDir;
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
      const file = await dir.getFileHandle(parts[parts.length - 1]!, { create: true });
      const sah = await (file as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle();
      return {
        write: (bytes, at) => sah.write(bytes, { at }),
        flush: () => sah.flush(),
        close: () => sah.close(),
      };
    },
  };
}

function takeLock(name: string): Promise<(() => void) | undefined> {
  return new Promise((granted, failed) => {
    navigator.locks
      .request(name, { mode: "exclusive", ifAvailable: true }, (lock) => {
        if (!lock) {
          granted(undefined);
          return;
        }
        return new Promise<void>((release) => granted(release));
      })
      .catch(failed);
  });
}

/** Dedicated WebWorker boot. Entry: `log-worker.ts`. */
export function bootLogWorker(): void {
  const scope = globalThis as unknown as {
    onmessage: ((ev: MessageEvent) => void) | null;
    postMessage(msg: unknown): void;
    close(): void;
  };
  const onMessage = serveLog({
    lock: takeLock,
    segments: opfsSegments,
    post: (msg) => scope.postMessage(msg),
    exit: () => scope.close(),
  });
  scope.onmessage = (ev) => onMessage(ev.data);
}

import type { TabId } from "./frame.js";
import type { AsyncFs } from "../opfs/async-fs.js";
import { TabWriter, type OutFrame, type SegmentFile, type SegmentStore } from "./tab-writer.js";

/**
 * A tab's handle on its own log. Appends made in one task go out as one
 * write and resolve once in the file; `flush` makes everything written so
 * far durable. In the browser it is a dedicated WebWorker holding the tab's
 * SyncAccessHandles; in Node and tests, a writer in this thread.
 */
export interface TabLogClient {
  append(frame: OutFrame): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

/** Wire messages to the log worker. Private to this module and log-worker.ts. */
export type ToLogWorker =
  | { readonly t: "open"; readonly name: string; readonly tab: TabId; readonly segmentBytes: number }
  | { readonly t: "write"; readonly id: number; readonly frames: readonly OutFrame[] }
  | { readonly t: "flush"; readonly id: number }
  | { readonly t: "close"; readonly id: number };

export type FromLogWorker =
  | { readonly t: "done"; readonly id: number }
  | { readonly t: "err"; readonly id: number; readonly message: string };

type Deferred = { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void };

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // An unawaited `flushed` must not surface as an unhandled rejection.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/** Gather the appends of one task into one batch for `send`. */
function batching(send: (frames: OutFrame[]) => Promise<void>): (frame: OutFrame) => Promise<void> {
  let frames: OutFrame[] = [];
  let group: Deferred | undefined;
  return (frame) => {
    if (!group) {
      const g = (group = deferred());
      queueMicrotask(() => {
        const batch = frames;
        frames = [];
        group = undefined;
        send(batch).then(g.resolve, g.reject);
      });
    }
    frames.push(frame);
    return group.promise;
  };
}

/**
 * Segments over any `AsyncFs`, for Node tests whose fs has no in-process
 * segments: each write republishes the whole file. Slow, and only for tests.
 */
export function republishingSegments(fs: AsyncFs): SegmentStore {
  return {
    async create(path) {
      let bytes = (await fs.read(path, 0, Number.POSITIVE_INFINITY)) ?? new Uint8Array(0);
      let chain: Promise<void> = Promise.resolve();
      const publish = (snapshot: Uint8Array) => {
        chain = chain.then(async () => {
          const w = await fs.create(path);
          await w.write(snapshot);
          await w.finish();
        });
      };
      publish(bytes);
      return {
        write(chunk, at) {
          const next = new Uint8Array(Math.max(bytes.byteLength, at + chunk.byteLength));
          next.set(bytes);
          next.set(chunk, at);
          bytes = next;
          publish(bytes);
          return chunk.byteLength;
        },
        flush() {},
        getSize: () => bytes.byteLength,
        close() {},
        settled: () => chain,
      } satisfies SegmentFile;
    },
  };
}

/** Node and tests: the writer runs in this thread. */
export function createLocalLogClient(
  store: SegmentStore,
  tab: TabId,
  segmentBytes: number,
): TabLogClient {
  const writer = new TabWriter(store, tab, segmentBytes);
  let chain: Promise<void> = Promise.resolve();
  const run = (fn: () => Promise<void> | void) => {
    const next = chain.then(fn);
    chain = next.catch(() => undefined);
    return next;
  };
  return {
    append: batching((frames) => run(() => writer.write(frames))),
    flush: () => run(() => writer.flush()),
    async close() {
      await chain;
      writer.close();
    },
  };
}

/**
 * How long a flush may take before the log counts as failed. Under an OPFS
 * quota, Chrome's `SyncAccessHandle.flush()` can block the log worker for
 * good. A flush adds no record, and the writes queued behind it never run
 * once the worker is terminated, so giving up on it cannot let a record
 * land after the other tabs retired this one. Writes get no such limit:
 * one that finished late could.
 */
const FLUSH_TIMEOUT_MS = 5_000;

/**
 * The browser client: talks to the log worker `worker`, already constructed
 * by the caller. The worker creates the tab's log directory once `held`
 * resolves: the tab's liveness lock is taken by then.
 */
export function createWorkerLogClient(
  worker: Worker,
  name: string,
  tab: TabId,
  segmentBytes: number,
  held: Promise<unknown>,
): TabLogClient {
  let nextId = 1;
  const pending = new Map<number, Deferred>();
  const fail = (err: unknown) => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  worker.onmessage = (ev: MessageEvent<readonly FromLogWorker[]>) => {
    for (const msg of ev.data) {
      const p = pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      if (msg.t === "done") p.resolve();
      else p.reject(new Error(msg.message));
    }
  };
  worker.onerror = (ev) => fail(new Error(`log worker failed: ${ev.message}`));
  const request = (msg: ToLogWorker & { id: number }, transfer: Transferable[] = []) => {
    const p = deferred();
    pending.set(msg.id, p);
    worker.postMessage(msg, transfer);
    return p.promise;
  };
  const open: ToLogWorker = { t: "open", name, tab, segmentBytes };
  void held.then(
    () => worker.postMessage(open),
    () => undefined,
  );
  return {
    append: batching((frames) =>
      request({ t: "write", id: nextId++, frames }, frames.map((f) => f.body.buffer as ArrayBuffer)),
    ),
    flush() {
      const flushed = request({ t: "flush", id: nextId++ });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stuck = new Promise<void>((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`log flush did not finish in ${FLUSH_TIMEOUT_MS} ms`);
          fail(err);
          worker.terminate();
          reject(err);
        }, FLUSH_TIMEOUT_MS);
      });
      return Promise.race([flushed, stuck]).finally(() => clearTimeout(timer));
    },
    async close() {
      await Promise.race([request({ t: "close", id: nextId++ }), new Promise((r) => setTimeout(r, 1000))]);
      fail(new Error("log client closed"));
      worker.terminate();
    },
  };
}

import { checkDbName, type DbName } from "../check.js";
import { IdBWal } from "../idb/wal.js";
import type { AsyncFs } from "../opfs/async-fs.js";
import { loadLatestGeneration } from "../store/generation.js";
import { installStep, mergeNextStep } from "./compact.js";
import { ingestAll } from "./ingest.js";
import {
  layersChannel,
  type ClientToHost,
  type HostToClient,
  type IngestClient,
} from "./protocol.js";

export type FsFactory = (name: DbName) => AsyncFs | Promise<AsyncFs>;

/** Compaction steps per pass. A real database's cascade needs far fewer. */
const MAX_COMPACTION_STEPS = 8;

/**
 * OPFS publisher + ingest owner. Runs in the SharedWorker in production;
 * tests use the same class in-process or behind a MessagePort.
 *
 * Every manifest publish runs under one exclusive section per database: a
 * chain in this host plus a Web Lock across hosts. Two SharedWorkers can
 * serve one database, for example two builds whose script URLs differ.
 * A flush holds it for the whole flush. Compaction merges without it and
 * holds it only to install the merged run.
 */
export class EngineHost {
  private readonly fsCache = new Map<string, AsyncFs>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly compactions = new Map<string, Promise<void>>();
  private readonly compactAgain = new Set<string>();

  constructor(private readonly fsFactory: FsFactory) {}

  async fsFor(name: DbName): Promise<AsyncFs> {
    let fs = this.fsCache.get(name);
    if (!fs) {
      fs = await this.fsFactory(name);
      this.fsCache.set(name, fs);
    }
    return fs;
  }

  /**
   * Flush every WAL record through `through` into an L0 run, then start
   * compaction in the background. With `settle`, also wait until the levels
   * are in shape.
   */
  async ingest(
    name: string,
    through: number,
    settle = false,
  ): Promise<{ generation: number }> {
    const dbName = checkDbName(name);
    const fs = await this.fsFor(dbName);
    const { generation } = await this.exclusive(dbName, () =>
      this.withWal(dbName, (wal) => ingestAll(wal, fs, through)),
    );
    const compaction = this.compact(dbName);
    if (!settle) {
      compaction.catch(() => undefined);
      return { generation };
    }
    await compaction;
    return { generation: (await loadLatestGeneration(fs))?.generation ?? 0 };
  }

  private exclusive<T>(dbName: DbName, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(dbName) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(() => withLock(`opfs-lsm-ingest/${dbName}`, fn));
    this.chains.set(
      dbName,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  private async withWal<T>(
    dbName: DbName,
    fn: (wal: IdBWal) => Promise<T>,
  ): Promise<T> {
    const wal = await IdBWal.open(dbName);
    try {
      return await fn(wal);
    } finally {
      wal.close();
    }
  }

  /** Run compaction passes until no request arrives during one. */
  private compact(dbName: DbName): Promise<void> {
    const running = this.compactions.get(dbName);
    if (running) {
      this.compactAgain.add(dbName);
      return running;
    }
    const run = (async () => {
      try {
        do {
          this.compactAgain.delete(dbName);
          await withLock(`opfs-lsm-compact/${dbName}`, () =>
            this.compactPass(dbName),
          );
        } while (this.compactAgain.has(dbName));
      } finally {
        this.compactions.delete(dbName);
      }
    })();
    this.compactions.set(dbName, run);
    return run;
  }

  private async compactPass(dbName: DbName): Promise<void> {
    const fs = await this.fsFor(dbName);
    for (let i = 0; i < MAX_COMPACTION_STEPS; i++) {
      const step = await mergeNextStep(fs);
      if (!step) return;
      await this.exclusive(dbName, () =>
        this.withWal(dbName, (wal) => installStep(fs, wal, step)),
      );
      announceGeneration(dbName);
    }
  }
}

/** Tell the tabs to install the new generation and drop the merged runs. */
function announceGeneration(dbName: DbName): void {
  if (typeof BroadcastChannel === "undefined") return;
  const bus = new BroadcastChannel(layersChannel(dbName));
  bus.postMessage({ kind: "ingest", writerId: "engine-host" });
  bus.close();
}

function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis as { navigator?: { locks?: LockManager } })
    .navigator?.locks;
  if (!locks) return fn();
  // The DOM lib types the callback's promise as the result, unwrapped at runtime.
  return locks.request(name, fn) as unknown as Promise<T>;
}

/** Serve EngineHost over a MessagePort (SharedWorker connection or test channel). */
export function attachEngineHostPort(
  port: MessagePort,
  host: EngineHost,
): () => void {
  const onMessage = async (ev: MessageEvent<ClientToHost>) => {
    const msg = ev.data;
    const reply = (m: HostToClient) => port.postMessage(m);
    try {
      switch (msg.type) {
        case "ping":
          reply({ type: "pong", id: msg.id });
          return;
        case "ingest": {
          const { generation } = await host.ingest(
            msg.name,
            msg.through,
            msg.settle,
          );
          reply({ type: "ingest-ok", id: msg.id, generation });
          return;
        }
        default: {
          const _exhaustive: never = msg;
          void _exhaustive;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (msg && typeof msg === "object" && "id" in msg) {
        reply({ type: "err", id: (msg as { id: number }).id, message });
      }
    }
  };
  const listener = onMessage as unknown as EventListener;
  port.addEventListener("message", listener);
  port.start?.();
  return () => port.removeEventListener("message", listener);
}

/** Tab-side client over a MessagePort. */
export function createPortIngestClient(port: MessagePort): IngestClient {
  let nextId = 1;
  const pending = new Map<
    number,
    {
      resolve: (v: { generation: number }) => void;
      reject: (e: Error) => void;
    }
  >();

  const onMessage = (ev: MessageEvent<HostToClient>) => {
    const msg = ev.data;
    switch (msg.type) {
      case "ingest-ok": {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          p.resolve({ generation: msg.generation });
        }
        return;
      }
      case "err": {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          p.reject(new Error(msg.message));
        }
        return;
      }
      case "pong":
        return;
      default: {
        const _exhaustive: never = msg;
        void _exhaustive;
      }
    }
  };
  const listener = onMessage as unknown as EventListener;
  port.addEventListener("message", listener);
  port.start?.();

  return {
    ingest(name: string, through: number, settle = false) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        const msg: ClientToHost = { type: "ingest", id, name, through, settle };
        port.postMessage(msg);
      });
    },
    close() {
      port.removeEventListener("message", listener);
      for (const [, p] of pending) p.reject(new Error("ingest client closed"));
      pending.clear();
    },
  };
}

export function createLocalIngestClient(host: EngineHost): IngestClient {
  return {
    ingest: (name, through, settle) => host.ingest(name, through, settle),
    close: () => undefined,
  };
}

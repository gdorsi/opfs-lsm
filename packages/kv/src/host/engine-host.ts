import { checkDbName, type DbName } from "../check.js";
import { IdBWal } from "../idb/wal.js";
import type { AsyncFs } from "../opfs/async-fs.js";
import { ingestAll } from "./ingest.js";
import type { ClientToHost, HostToClient, IngestClient } from "./protocol.js";

export type FsFactory = (name: DbName) => AsyncFs | Promise<AsyncFs>;

/**
 * OPFS publisher + ingest owner. Runs in the SharedWorker in production;
 * tests use the same class in-process or behind a MessagePort.
 */
export class EngineHost {
  private readonly fsCache = new Map<string, AsyncFs>();
  private readonly ingestChain = new Map<string, Promise<unknown>>();

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
   * Serialize ingest per database name. Opens a fresh IdBWal handle for the
   * shared WAL, publishes L0/generation via AsyncFs, advances ingestedThrough.
   */
  ingest(name: string, through: number): Promise<{ generation: number }> {
    const dbName = checkDbName(name);
    const prev = this.ingestChain.get(dbName) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(() => this.runIngest(dbName, through));
    this.ingestChain.set(
      dbName,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  /**
   * Two SharedWorkers can serve one database, for example two builds whose
   * script URLs differ. A Web Lock per name keeps their ingests apart.
   */
  private runIngest(
    dbName: DbName,
    through: number,
  ): Promise<{ generation: number }> {
    const locks = (globalThis as { navigator?: { locks?: LockManager } })
      .navigator?.locks;
    if (!locks) return this.ingestUnlocked(dbName, through);
    // The DOM lib types the callback's promise as the result, unwrapped at runtime.
    return locks.request(`opfs-lsm-ingest/${dbName}`, () =>
      this.ingestUnlocked(dbName, through),
    ) as unknown as Promise<{ generation: number }>;
  }

  private async ingestUnlocked(
    dbName: DbName,
    through: number,
  ): Promise<{ generation: number }> {
    const fs = await this.fsFor(dbName);
    const wal = await IdBWal.open(dbName);
    try {
      const result = await ingestAll(wal, fs, through);
      return { generation: result.generation };
    } finally {
      wal.close();
    }
  }
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
          const { generation } = await host.ingest(msg.name, msg.through);
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
    ingest(name: string, through: number) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        const msg: ClientToHost = { type: "ingest", id, name, through };
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
    ingest: (name, through) => host.ingest(name, through),
    close: () => undefined,
  };
}

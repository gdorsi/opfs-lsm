import type { DbName } from "../check.js";
import { ClosedError, errorOfCode } from "../errors.js";
import { parseHostToPage, type HostStats, type HostToPage, type PageToHost } from "./protocol.js";
import type { LogId, RecordN } from "./queues.js";

/** A SharedWorker's port, or one end of a MessageChannel to a host on this thread. */
export type LinkPort = {
  postMessage(msg: unknown): void;
  onmessage: ((ev: MessageEvent) => void) | null;
  close(): void;
};

type Waiter = { readonly resolve: (msg: HostToPage) => void; readonly reject: (err: unknown) => void };

/**
 * The page's end of its port to the host. Requests carry an id the host
 * answers once; a `failed` answer rejects with the error its code names.
 * The host's `flush` asks go to `onFlush`, and the link answers `flushed`
 * once it settles, whether it flushed or failed: the host only waits on it.
 */
export class HostLink {
  private nextId = 1;
  private readonly waiting = new Map<number, Waiter>();
  private closed = false;

  constructor(
    private readonly port: LinkPort,
    private readonly onFlush: (rotate: readonly LogId[]) => Promise<void>,
  ) {
    port.onmessage = (ev) => this.onMessage(ev.data);
  }

  /** Joins `db`'s host. Resolves with the generation that holds what every page flushed before the call. */
  attach(db: DbName): Promise<number> {
    return this.generation((id) => ({ t: "attach", id, db }));
  }

  /** The newest generation once the host ingested what every page flushed before the call. */
  sync(): Promise<number> {
    return this.generation((id) => ({ t: "sync", id }));
  }

  /** `sync`, then compaction until a pass installs nothing. */
  settle(): Promise<number> {
    return this.generation((id) => ({ t: "settle", id }));
  }

  async stats(): Promise<HostStats> {
    const reply = await this.request((id) => ({ t: "stats", id }));
    if (reply.t !== "stats") throw new Error(`host answered stats with ${reply.t}`);
    return reply.stats;
  }

  /** Records 1..n of `log`, `bytes` of bodies, are flushed. */
  durable(log: LogId, n: RecordN, bytes: number): void {
    this.post({ t: "durable", log, n, bytes });
  }

  /** Leaves the host's pages, so it asks this page nothing until the next `attach`. */
  detach(): void {
    this.post({ t: "detach" });
  }

  close(): void {
    if (this.closed) return;
    this.detach();
    this.closed = true;
    this.port.onmessage = null;
    this.port.close();
    for (const w of this.waiting.values()) w.reject(new ClosedError("database is closed"));
    this.waiting.clear();
  }

  private post(msg: PageToHost): void {
    if (!this.closed) this.port.postMessage(msg);
  }

  private request(make: (id: number) => PageToHost): Promise<HostToPage> {
    if (this.closed) return Promise.reject(new ClosedError("database is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.post(make(id));
    });
  }

  private async generation(make: (id: number) => PageToHost): Promise<number> {
    const reply = await this.request(make);
    if (reply.t !== "done") throw new Error(`host answered with ${reply.t}`);
    return reply.generation;
  }

  private onMessage(data: unknown): void {
    const msg = parseHostToPage(data);
    if (!msg) {
      console.error("opfs-lsm: the host sent a message this page does not read", data);
      return;
    }
    if (msg.t === "flush") {
      const { id } = msg;
      void this.onFlush(msg.rotate).then(
        () => this.post({ t: "flushed", id }),
        () => this.post({ t: "flushed", id }),
      );
      return;
    }
    const waiter = this.waiting.get(msg.id);
    if (!waiter) return;
    this.waiting.delete(msg.id);
    if (msg.t === "failed") waiter.reject(errorOfCode(msg.code, msg.message));
    else waiter.resolve(msg);
  }
}

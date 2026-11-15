import { mergeIncoming, mergePulled, restore } from "../domain/merge.ts";
import type { Clocks, Rows, ServerRow, SyncState } from "../domain/model.ts";
import { STORES, STREAMS, type Stream } from "../domain/stores.ts";
import { MAX_DETAIL_IDS, MAX_OPS, type DetailResponse, type PullResponse, type PushOp, type PushResponse } from "../domain/wire.ts";
import type { Backend, StoreRows } from "./backend.ts";
import { fromSnapshots, observe, type Live, type Snapshot, type Unsubscribe } from "./live.ts";
import { backoffMs, Pager, pushOp } from "./ops.ts";
import { unsent } from "./query.ts";
import { TransportError, type Transport } from "./transport.ts";

/** The shape of stored rows. The sync leader clears a replica written under another format and pulls it again. */
const FORMAT = 4;
const PULL_LIMIT = 2000;
const FULL = STREAMS.filter((s) => STORES[s].pull === "full");
const BACKGROUND = STREAMS.filter((s) => STORES[s].pull === "threads");
/** Preload delay: a scroll that passes rows by does not ask for them. */
const PRELOAD_DELAY_MS = 200;

export type SyncStatus =
  | { readonly kind: "starting"; readonly unsynced: number }
  | { readonly kind: "offline"; readonly unsynced: number }
  | { readonly kind: "syncing"; readonly stream: Stream; readonly cursor: number; readonly head: number; readonly unsynced: number }
  | { readonly kind: "idle"; readonly unsynced: number };

/** Whether storage pressure waits for the user's confirmation, and the unsent body and comment edits a removal waits for. */
export type Pressure = { readonly pending: boolean; readonly unsent: number };

export interface Sync {
  /**
   * Leads sync for every tab on this replica until `signal` aborts: pushes the outbox and pulls, on every head the
   * server announces, every local edit and every reconnect, with backoff. One tab leads at a time, so the app calls
   * it inside a Web Lock.
   */
  lead(signal: AbortSignal): Promise<void>;
  /** Resolves once the outbox is empty and every stream has reached the head the leader knows. Rejects unless this model leads. */
  settled(): Promise<void>;
  /** Loads the threads of `ids` this replica lacks, once `ids` held still for 200 ms; an abort of `signal` before that cancels it. */
  preload(ids: readonly string[], signal?: AbortSignal): Promise<void>;
  readonly status: Live<SyncStatus>;
  readonly pressure: Live<Pressure>;
  /** Agrees, from any tab, to clear the cached bodies and comments that storage pressure asked for. */
  confirmEviction(): Promise<void>;
}

export type SyncOptions = {
  readonly pullLimit?: number;
  /** Called the first time this leader finds a stream caught up with the server. */
  readonly onCaughtUp?: (stream: Stream) => void;
};

const perStream = <T>(value: T) => Object.fromEntries(STREAMS.map((s) => [s, value])) as Record<Stream, T>;

const EMPTY: SyncState = {
  id: "sync",
  format: FORMAT,
  epoch: null,
  cursors: perStream(0),
  head: 0,
  online: false,
  caughtUp: perStream(false),
  evict: "idle",
};

class EpochChanged extends Error {
  readonly epoch: string;
  constructor(epoch: string) {
    super(`the server was reseeded (epoch ${epoch})`);
    this.epoch = epoch;
  }
}

/** Of the issues the rows belong to, those whose body the replica holds, which means it holds their whole thread. */
async function heldThreads(backend: Backend, rows: readonly ServerRow[]): Promise<ReadonlySet<string>> {
  const ids = [...new Set(rows.map((r) => ("issue_id" in r ? r.issue_id : r.id)))];
  const bodies = await backend.read("bodies", ids);
  return new Set(ids.filter((_, i) => bodies[i]));
}

type Incoming<S extends Stream> = Omit<StoreRows[S], "dirty" | "pending">;

/**
 * A crash partway costs a re-pull, since merging a row again changes nothing. With `held` (pulled bodies and comments),
 * a row for an issue outside it is dropped unless the replica has the row.
 */
function mergeServerRows<S extends Stream>(backend: Backend, stream: S, rows: readonly ServerRow<S>[], held?: ReadonlySet<string>) {
  return backend.transact(stream, rows as unknown as readonly Incoming<S>[], (local, row) =>
    held ? mergePulled<StoreRows[S]>(local, row, held.has("issue_id" in row ? (row.issue_id as string) : row.id)) : mergeIncoming<StoreRows[S]>(local, row),
  );
}

/** Rows of the server's answer to a push, each merged with the clocks it confirms. */
function mergeAcks<S extends Stream>(backend: Backend, stream: S, acks: readonly { readonly id: string; readonly row: ServerRow<S>; readonly clocks: Clocks }[]) {
  return backend.transact(stream, acks, (local, ack) => mergeIncoming<StoreRows[S]>(local, ack.row as unknown as Incoming<S>, ack.clocks));
}

/** The rows with unsent edits, per stream: what the leader pushes. */
const outboxOf = (backend: Backend) => ({
  issues: unsent(backend.collection("issues")),
  bodies: unsent(backend.collection("bodies")),
  comments: unsent(backend.collection("comments")),
});
type Outbox = ReturnType<typeof outboxOf>;

type Loop =
  | { readonly kind: "idle" }
  | { readonly kind: "running"; wake: boolean }
  | { readonly kind: "waiting"; readonly timer: ReturnType<typeof setTimeout> };

type Reason = "start" | "hint" | "dirty" | "online" | "pressure";

type Outgoing = { readonly op: PushOp; readonly key: string };

class Leader {
  private loop: Loop = { kind: "idle" };
  private running: Promise<void> | undefined;
  private stopped = false;
  private state: SyncState = EMPTY;
  private head: number | undefined;
  private readonly marked = new Set<Stream>();
  private readonly offs: Unsubscribe[] = [];
  private readonly waiters: { resolve(): void; reject(err: Error): void }[] = [];
  private readonly backend: Backend;
  private readonly outbox: Outbox;
  private readonly transport: Transport;
  private readonly onCaughtUp: ((stream: Stream) => void) | undefined;
  private readonly pager: Pager<PullResponse>;

  constructor(backend: Backend, outbox: Outbox, transport: Transport, { pullLimit = PULL_LIMIT, onCaughtUp }: SyncOptions) {
    this.backend = backend;
    this.outbox = outbox;
    this.transport = transport;
    this.onCaughtUp = onCaughtUp;
    this.pager = new Pager((stream, after) => transport.pull(stream, after, pullLimit));
  }

  async start(): Promise<void> {
    const [saved] = await this.backend.read("sync", ["sync"]);
    // A row written before `evict` existed reads as idle.
    this.state = { ...EMPTY, ...saved };
    const onWrite = (changes: ReadonlyArray<{ type: string }>) => {
      if (changes.some((c) => c.type !== "delete")) this.kick("dirty");
    };
    const { issues, bodies, comments } = this.outbox;
    const subscriptions = [
      issues.subscribeChanges(onWrite),
      bodies.subscribeChanges(onWrite),
      comments.subscribeChanges(onWrite),
      this.backend.collection("sync").subscribeChanges((changes) => {
        if (changes.some((c) => c.value.evict === "confirmed" && c.previousValue?.evict !== "confirmed")) this.kick("pressure");
      }),
    ];
    this.offs.push(() => {
      for (const s of subscriptions) s.unsubscribe();
    });
    this.offs.push(
      this.transport.watch((head) => {
        if (!this.state.online) void this.save({ online: true }).catch(() => undefined);
        this.head = Math.max(this.head ?? 0, head);
        this.kick("hint");
      }),
      this.transport.online(() => this.kick("online")),
    );
    // Every tab shows the alert while `evict` is asked. A confirmation from any tab lands in the row, and the loop
    // evicts after a push, so no page lands rows after the clear.
    const unpressure = this.backend.onPressure?.(async () => {
      if (this.state.evict === "idle") await this.save({ evict: "asked" });
    });
    if (unpressure) this.offs.push(unpressure);
    this.kick("start");
  }

  /** Stops the loop and resolves once a cycle in flight has ended. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const off of this.offs.splice(0)) off();
    if (this.loop.kind === "waiting") clearTimeout(this.loop.timer);
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error("linearlite stopped leading sync"));
    await this.running;
  }

  settled(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.checkSettled();
    });
  }

  /** Each cycle's push has loaded the outbox, so an idle loop reads it as the backend holds it. */
  private checkSettled(): void {
    if (this.waiters.length === 0 || this.loop.kind !== "idle" || STREAMS.some((s) => this.stale(s) || this.outbox[s].size > 0)) return;
    for (const waiter of this.waiters.splice(0)) waiter.resolve();
  }

  private kick(reason: Reason): void {
    if (this.stopped) return;
    const loop = this.loop;
    switch (loop.kind) {
      case "idle":
        this.running = this.run(0);
        return;
      case "running":
        loop.wake = true;
        return;
      case "waiting":
        if (reason === "dirty") return;
        clearTimeout(loop.timer);
        this.running = this.run(0);
        return;
    }
  }

  private async run(failures: number): Promise<void> {
    const loop = { kind: "running" as const, wake: true };
    this.loop = loop;
    try {
      while (loop.wake && !this.stopped) {
        loop.wake = false;
        try {
          await this.cycle(loop);
        } catch (err) {
          if (!(err instanceof EpochChanged)) throw err;
          await this.wipe(err.epoch);
          loop.wake = true;
        }
      }
      this.loop = { kind: "idle" };
      this.checkSettled();
    } catch (err) {
      if (this.stopped) {
        this.loop = { kind: "idle" };
        return;
      }
      const next = failures + 1;
      console.warn(`linearlite sync failed (${next}), retrying in ${backoffMs(next)} ms`, err);
      if (this.state.online) await this.save({ online: false }).catch(() => undefined);
      this.loop = { kind: "waiting", timer: setTimeout(() => (this.running = this.run(next)), backoffMs(next)) };
    }
  }

  private async cycle(loop: { wake: boolean }): Promise<void> {
    await this.push();
    if (this.state.format !== FORMAT) await this.wipe(this.state.epoch);
    await this.catchUpFull(loop);
    await this.startAtHead();
    for (const stream of BACKGROUND) {
      while (this.stale(stream)) {
        await this.page(stream);
        if (loop.wake) {
          loop.wake = false;
          await this.push();
          await this.catchUpFull(loop);
        }
      }
    }
  }

  private async catchUpFull(loop: { wake: boolean }): Promise<void> {
    for (const stream of FULL) {
      while (this.stale(stream)) {
        await this.page(stream);
        if (loop.wake) {
          loop.wake = false;
          await this.push();
        }
      }
    }
  }

  /**
   * Bodies and comments are not pulled from the start: a replica loads an issue's when it becomes visible
   * (`preload`), and from here pulls only what changes, for the issues it holds.
   */
  private async startAtHead(): Promise<void> {
    const { caughtUp, cursors } = this.state;
    if (BACKGROUND.some((s) => !caughtUp[s])) {
      await this.save({
        cursors: { ...cursors, ...Object.fromEntries(BACKGROUND.map((s) => [s, this.head!])) },
        caughtUp: { ...caughtUp, ...Object.fromEntries(BACKGROUND.map((s) => [s, true])) },
      });
    }
    for (const stream of BACKGROUND) this.mark(stream);
  }

  private mark(stream: Stream): void {
    if (this.marked.has(stream)) return;
    this.marked.add(stream);
    this.onCaughtUp?.(stream);
  }

  private stale(stream: Stream): boolean {
    return !this.state.caughtUp[stream] || this.head === undefined || this.state.cursors[stream] < this.head;
  }

  private async page(stream: Stream): Promise<void> {
    const res = await this.pager.page(stream, this.state.cursors[stream]);
    this.checkEpoch(res.epoch);
    if (res.rows.length > 0) await mergeServerRows(this.backend, stream, res.rows, stream === "issues" ? undefined : await heldThreads(this.backend, res.rows));
    this.head = Math.max(this.head ?? 0, res.head);
    await this.save({
      epoch: res.epoch,
      head: this.head,
      online: true,
      cursors: { ...this.state.cursors, [stream]: res.next },
      caughtUp: { ...this.state.caughtUp, [stream]: !res.more },
    });
    if (!res.more) this.mark(stream);
  }

  private checkEpoch(epoch: string): void {
    if (this.state.epoch !== null && this.state.epoch !== epoch) throw new EpochChanged(epoch);
  }

  /** Sends every row with unsent edits. An ack clears only the fields it confirms, so an edit made meanwhile stays to send. */
  private async push(): Promise<void> {
    const outgoing: Outgoing[] = [];
    for (const stream of STREAMS) {
      const rows = this.outbox[stream];
      await rows.preload();
      for (const row of rows.toArray) {
        const op = pushOp(stream, row);
        if (op) outgoing.push({ op, key: row.id });
      }
    }
    if (outgoing.length > 0) this.pager.forget();
    for (let i = 0; i < outgoing.length; i += MAX_OPS) await this.send(outgoing.slice(i, i + MAX_OPS));
    if (this.backend.collection("sync").get("sync")?.evict === "confirmed") await this.evict();
  }

  /**
   * Frees space for kv's size cap once a user confirmed: drops every body and comment, which are loaded again when
   * their issue is visible or opened. Issues stay. Runs right after a push, and waits while a body or comment still
   * has an unsent edit; the next push tries again.
   */
  private async evict(): Promise<void> {
    if (BACKGROUND.some((s) => this.outbox[s].size > 0)) return;
    for (const name of BACKGROUND) await this.backend.clear(name);
    await this.save({ evict: "idle" });
  }

  /**
   * A refused batch is retried one op at a time, so one bad op cannot wedge sync. An op the server refuses on its
   * own is dropped: the row is reset to what the server holds, or deleted when the server has none.
   */
  private async send(batch: readonly Outgoing[]): Promise<void> {
    let res: PushResponse;
    try {
      res = await this.transport.push(batch.map((o) => o.op));
    } catch (err) {
      if (!(err instanceof TransportError) || err.status >= 500) throw err;
      if (batch.length > 1) {
        for (const one of batch) await this.send([one]);
        return;
      }
      console.warn("linearlite push refused, dropping the edit", batch[0]!.op, err);
      await this.drop(batch[0]!);
      return;
    }
    this.checkEpoch(res.epoch);
    this.head = Math.max(this.head ?? 0, res.head);
    for (const stream of STREAMS) {
      const acks = res.results.filter((r) => r.stream === stream);
      if (acks.length === 0) continue;
      await mergeAcks(this.backend, stream, acks as unknown as readonly { id: string; row: ServerRow<typeof stream>; clocks: Clocks }[]);
    }
  }

  /** A pull would not do: it skips a row whose version it already has, and a refused create has no server row to pull. */
  private async drop({ op, key }: Outgoing): Promise<void> {
    const res = await this.transport.row(op.stream, op.id);
    this.checkEpoch(res.epoch);
    const server = res.row as unknown as Incoming<typeof op.stream> | null;
    await this.backend.transact(op.stream, [{ id: key }], (local) => restore<Rows[typeof op.stream]>(local, server, op.clocks));
  }

  /** The leader owns the row, except `evict`, which another tab may confirm: a save keeps the stored one unless it sets it. */
  private async save(patch: Partial<SyncState>): Promise<void> {
    this.state = { ...this.state, ...patch };
    await this.backend.transact("sync", [this.state], (row, state) => ({ ...state, evict: patch.evict ?? row?.evict ?? state.evict }));
  }

  private async wipe(epoch: string | null): Promise<void> {
    for (const name of STREAMS) await this.backend.clear(name);
    this.pager.forget();
    this.head = undefined;
    this.marked.clear();
    await this.save({ ...EMPTY, epoch });
  }
}

/** Threads fetched whole from the server. Rows join the replica here, unlike a pull's. */
export function threadFetcher(backend: Backend, transport: Transport) {
  /** Ids asked for and not answered with a body: in flight, or the server has none. Not asked again by `preload`. */
  const asked = new Set<string>();

  async function fetch(ids: readonly string[]): Promise<DetailResponse> {
    const res = await transport.detail(ids);
    if (res.bodies.length > 0) await mergeServerRows(backend, "bodies", res.bodies);
    if (res.comments.length > 0) await mergeServerRows(backend, "comments", res.comments);
    return res;
  }

  /**
   * Loads the threads of issues that came into view, in requests of up to `MAX_DETAIL_IDS`. It skips those whose body
   * the replica holds, those being asked for and those the server has no body for. A failed request is forgotten, so
   * the ids are asked for again the next time they are seen.
   */
  async function preload(ids: readonly string[]): Promise<void> {
    const held = await backend.read("bodies", ids);
    const wanted = ids.filter((id, i) => !held[i] && !asked.has(id));
    for (let at = 0; at < wanted.length; at += MAX_DETAIL_IDS) {
      const batch = wanted.slice(at, at + MAX_DETAIL_IDS);
      for (const id of batch) asked.add(id);
      try {
        for (const { id } of (await fetch(batch)).bodies) asked.delete(id);
      } catch (err) {
        for (const id of batch) asked.delete(id);
        console.warn("linearlite could not preload details", err);
      }
    }
  }

  return { fetch, preload };
}

/** Resolves true after `ms`, or false as soon as `signal` aborts. */
const stillAfter = (ms: number, signal: AbortSignal | undefined) =>
  new Promise<boolean>((resolve) => {
    if (signal?.aborted) return resolve(false);
    const aborted = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", aborted);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", aborted, { once: true });
  });

const rowsOf = (s: Snapshot) => s.data as readonly unknown[];
const syncRow = (s: Snapshot) => s.state?.get("sync") as SyncState | undefined;

export function openSync(backend: Backend, transport: Transport, threads: ReturnType<typeof threadFetcher>, options: SyncOptions): Sync {
  let leader: Leader | undefined;
  const outbox = outboxOf(backend);
  const row = observe(backend.collection("sync"));
  const issues = observe(outbox.issues);
  const bodies = observe(outbox.bodies);
  const comments = observe(outbox.comments);
  return {
    async lead(signal) {
      if (leader) throw new Error("this model already leads sync");
      const current = new Leader(backend, outbox, transport, options);
      leader = current;
      try {
        await current.start().catch((err: unknown) => console.error("linearlite sync did not start", err));
        if (!signal.aborted) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      } finally {
        leader = undefined;
        await current.stop();
      }
    },
    settled: () => leader?.settled() ?? Promise.reject(new Error("settled() waits on the sync leader, and this model does not lead")),
    async preload(ids, signal) {
      if (ids.length > 0 && (await stillAfter(PRELOAD_DELAY_MS, signal))) await threads.preload(ids);
    },
    status: fromSnapshots([row, issues, bodies, comments], (sync, issues, bodies, comments): SyncStatus => {
      const state = syncRow(sync);
      const unsynced = rowsOf(issues).length + rowsOf(bodies).length + rowsOf(comments).length;
      if (!state) return { kind: "starting", unsynced };
      if (!state.online) return { kind: "offline", unsynced };
      const behind = STREAMS.find((s) => !state.caughtUp[s]);
      if (behind) return { kind: "syncing", stream: behind, cursor: state.cursors[behind], head: state.head, unsynced };
      return { kind: "idle", unsynced };
    }),
    pressure: fromSnapshots([row, bodies, comments], (sync, bodies, comments) => {
      const evict = syncRow(sync)?.evict;
      return { pending: evict === "asked" || evict === "confirmed", unsent: rowsOf(bodies).length + rowsOf(comments).length };
    }),
    confirmEviction: () => backend.transact("sync", [{ id: "sync" }], (row) => (row?.evict === "asked" ? { ...row, evict: "confirmed" } : undefined)),
  };
}

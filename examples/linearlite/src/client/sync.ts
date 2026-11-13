import { mergeIncoming, restore } from "../domain/merge.ts";
import type { Clocks, Rows, ServerRow, Stream, SyncState } from "../domain/model.ts";
import { MAX_OPS, type DetailResponse, type PullResponse, type PushOp, type PushResponse, type RowResponse } from "../domain/wire.ts";
import { backoffMs, Pager, pushOp } from "./ops.ts";
import { FORMAT, openStore, transact, type Store } from "./store.ts";

const PULL_LIMIT = 2000;
const BACKGROUND = ["bodies", "comments"] as const;

const EMPTY: SyncState = {
  id: "sync",
  format: FORMAT,
  epoch: null,
  cursors: { issues: 0, bodies: 0, comments: 0 },
  head: 0,
  online: false,
  caughtUp: { issues: false, bodies: false, comments: false },
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

class EpochChanged extends Error {
  constructor(readonly epoch: string) {
    super(`the server was reseeded (epoch ${epoch})`);
  }
}

async function request<T>(user: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-linearlite-user": user },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new HttpError(res.status, `${url}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

type Transact<T, K extends string = string> = (
  keys: readonly K[],
  merge: (rows: ReadonlyArray<T | undefined>) => ReadonlyArray<T | null | undefined>,
) => Promise<void>;

async function read<T, K extends string>(transact: Transact<T, K>, keys: readonly K[]): Promise<ReadonlyArray<T | undefined>> {
  let rows: ReadonlyArray<T | undefined> = [];
  await transact(keys, (stored) => {
    rows = stored;
    return stored.map(() => undefined);
  });
  return rows;
}

/** kv's cap on the operations of one write batch (docstore README, "Limits"). */
const KV_BATCH_OPS = 10_000;

/**
 * The most rows of `stream` one `transact` can write within kv's batch cap. A row write is the row plus, per index,
 * at most a delete of its old entry and a put of its new one; every index here holds at most one entry per row.
 */
const rowsPerBatch = (store: Store, stream: Stream) => Math.floor(KV_BATCH_OPS / (1 + 2 * store.docs.collection(stream).indexes.size));

/** Each slice is its own transaction; a crash between two costs a re-pull, since merging a row again changes nothing. */
export async function mergeServerRows<S extends Stream>(store: Store, stream: S, rows: readonly ServerRow<S>[], acked?: readonly Clocks[]) {
  const incoming = rows as unknown as readonly Omit<Rows[S], "dirty" | "pending">[];
  const step = rowsPerBatch(store, stream);
  for (let at = 0; at < incoming.length; at += step) {
    const slice = incoming.slice(at, at + step);
    await transact(
      store,
      stream,
      slice.map((row) => row.id),
      (locals) => slice.map((row, i) => mergeIncoming<Rows[S]>(locals[i], row, acked?.[at + i])),
    );
  }
}

type Loop =
  | { readonly kind: "idle" }
  | { readonly kind: "running"; wake: boolean }
  | { readonly kind: "waiting"; readonly timer: ReturnType<typeof setTimeout> };

type Reason = "start" | "hint" | "dirty" | "online";

type Outgoing = { readonly op: PushOp; readonly key: string };

class Leader {
  private loop: Loop = { kind: "idle" };
  private state: SyncState = EMPTY;
  private head: number | undefined;
  private readonly marked = new Set<Stream>();
  private readonly pullLimit = Number(new URLSearchParams(location.search).get("pull")) || PULL_LIMIT;
  private readonly pager = new Pager((stream, after) =>
    request<PullResponse>(this.store.user, `/api/pull?stream=${stream}&after=${after}&limit=${this.pullLimit}`),
  );

  constructor(private readonly store: Store) {}

  async start(): Promise<void> {
    const [saved] = await read(this.store.sync.utils.transact, ["sync"]);
    this.state = saved ?? EMPTY;
    const onWrite = (changes: ReadonlyArray<{ type: string }>) => {
      if (changes.some((c) => c.type !== "delete")) this.kick("dirty");
    };
    const { dirtyIssues, dirtyBodies, dirtyComments } = this.store;
    dirtyIssues.subscribeChanges(onWrite);
    dirtyBodies.subscribeChanges(onWrite);
    dirtyComments.subscribeChanges(onWrite);
    addEventListener("online", () => this.kick("online"));
    new EventSource("/api/events").onmessage = (e: MessageEvent<string>) => {
      const { head } = JSON.parse(e.data) as { head: number };
      if (!this.state.online) void this.save({ online: true }).catch(() => undefined);
      this.head = Math.max(this.head ?? 0, head);
      this.kick("hint");
    };
    this.kick("start");
  }

  private kick(reason: Reason): void {
    const loop = this.loop;
    switch (loop.kind) {
      case "idle":
        void this.run(0);
        return;
      case "running":
        loop.wake = true;
        return;
      case "waiting":
        if (reason === "dirty") return;
        clearTimeout(loop.timer);
        void this.run(0);
        return;
    }
  }

  private async run(failures: number): Promise<void> {
    const loop = { kind: "running" as const, wake: true };
    this.loop = loop;
    try {
      while (loop.wake) {
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
    } catch (err) {
      const next = failures + 1;
      console.warn(`linearlite sync failed (${next}), retrying in ${backoffMs(next)} ms`, err);
      if (this.state.online) await this.save({ online: false }).catch(() => undefined);
      this.loop = { kind: "waiting", timer: setTimeout(() => void this.run(next), backoffMs(next)) };
    }
  }

  private async cycle(loop: { wake: boolean }): Promise<void> {
    await this.push();
    if (this.state.format !== FORMAT) await this.wipe(this.state.epoch);
    await this.catchUpIssues(loop);
    for (const stream of BACKGROUND) {
      while (this.stale(stream)) {
        await this.page(stream);
        if (loop.wake) {
          loop.wake = false;
          await this.push();
          await this.catchUpIssues(loop);
        }
      }
    }
  }

  private async catchUpIssues(loop: { wake: boolean }): Promise<void> {
    while (this.stale("issues")) {
      await this.page("issues");
      if (loop.wake) {
        loop.wake = false;
        await this.push();
      }
    }
  }

  private stale(stream: Stream): boolean {
    return !this.state.caughtUp[stream] || this.head === undefined || this.state.cursors[stream] < this.head;
  }

  private async page(stream: Stream): Promise<void> {
    const res = await this.pager.page(stream, this.state.cursors[stream]);
    this.checkEpoch(res.epoch);
    if (res.rows.length > 0) await mergeServerRows(this.store, stream, res.rows);
    this.head = Math.max(this.head ?? 0, res.head);
    await this.save({
      epoch: res.epoch,
      head: this.head,
      online: true,
      cursors: { ...this.state.cursors, [stream]: res.next },
      caughtUp: { ...this.state.caughtUp, [stream]: !res.more },
    });
    if (!res.more && !this.marked.has(stream)) {
      this.marked.add(stream);
      performance.mark(`linearlite:caught-up:${stream}`);
    }
  }

  private checkEpoch(epoch: string): void {
    if (this.state.epoch !== null && this.state.epoch !== epoch) throw new EpochChanged(epoch);
  }

  private dirty() {
    const { dirtyIssues, dirtyBodies, dirtyComments } = this.store;
    return [
      { stream: "issues", rows: dirtyIssues },
      { stream: "bodies", rows: dirtyBodies },
      { stream: "comments", rows: dirtyComments },
    ] as const;
  }

  /** Sends every row with unsent edits. An ack clears only the fields it confirms, so an edit made meanwhile stays to send. */
  private async push(): Promise<void> {
    const outgoing: Outgoing[] = [];
    for (const { stream, rows } of this.dirty()) {
      await rows.preload();
      for (const row of rows.toArray) {
        const op = pushOp(stream, row);
        if (op) outgoing.push({ op, key: row.id });
      }
    }
    if (outgoing.length > 0) this.pager.forget();
    for (let i = 0; i < outgoing.length; i += MAX_OPS) await this.send(outgoing.slice(i, i + MAX_OPS));
  }

  /**
   * A refused batch is retried one op at a time, so one bad op cannot wedge sync. An op the server refuses on its
   * own is dropped: the row is reset to what the server holds, or deleted when the server has none.
   */
  private async send(batch: readonly Outgoing[]): Promise<void> {
    let res: PushResponse;
    try {
      res = await request<PushResponse>(this.store.user, "/api/push", { ops: batch.map((o) => o.op) });
    } catch (err) {
      if (!(err instanceof HttpError) || err.status >= 500) throw err;
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
    for (const stream of ["issues", ...BACKGROUND] as const) {
      const acks = res.results.filter((r) => r.stream === stream);
      if (acks.length === 0) continue;
      await mergeServerRows(this.store, stream, acks.map((r) => r.row as ServerRow<typeof stream>), acks.map((r) => r.clocks));
    }
  }

  /** A pull would not do: it skips a row whose version it already has, and a refused create has no server row to pull. */
  private async drop({ op, key }: Outgoing): Promise<void> {
    const res = await request<RowResponse>(this.store.user, `/api/row?stream=${op.stream}&id=${encodeURIComponent(op.id)}`);
    this.checkEpoch(res.epoch);
    const server = res.row as unknown as Omit<Rows[typeof op.stream], "dirty" | "pending"> | null;
    await transact(this.store, op.stream, [key], ([local]) => [restore<Rows[typeof op.stream]>(local, server, op.clocks)]);
  }

  private async save(patch: Partial<SyncState>): Promise<void> {
    this.state = { ...this.state, ...patch };
    const state = this.state;
    await this.store.sync.utils.transact(["sync"], () => [state]);
  }

  private async wipe(epoch: string | null): Promise<void> {
    const { docs } = this.store;
    for (const name of ["issues", ...BACKGROUND] as const) await docs.collection(name).clear();
    this.pager.forget();
    this.head = undefined;
    this.marked.clear();
    await this.save({ ...EMPTY, epoch });
  }
}

const started = new WeakSet<Store>();

export function startSync(store: Store): void {
  if (started.has(store)) return;
  started.add(store);
  void navigator.locks.request("linearlite:sync", () => {
    performance.mark("linearlite:leader");
    void new Leader(store).start().catch((err: unknown) => console.error("linearlite sync did not start", err));
    return new Promise<never>(() => {});
  });
}

export async function fetchDetail(id: string): Promise<void> {
  const store = await openStore();
  const res = await request<DetailResponse>(store.user, `/api/detail?id=${encodeURIComponent(id)}`);
  if (res.body) await mergeServerRows(store, "bodies", [res.body]);
  if (res.comments.length > 0) await mergeServerRows(store, "comments", res.comments);
}

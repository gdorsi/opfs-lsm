import { mergeIncoming, mergePulled, restore } from "../domain/merge.ts";
import type { Clocks, Rows, ServerRow, Stream, SyncState } from "../domain/model.ts";
import { MAX_DETAIL_IDS, MAX_OPS, type DetailResponse, type PullResponse, type PushOp, type PushResponse, type RowResponse } from "../domain/wire.ts";
import { backoffMs, Pager, pushOp } from "./ops.ts";
import { FORMAT, openStore, transact, type Store } from "./store.ts";

const PULL_LIMIT = 2000;
const BACKGROUND = ["bodies", "comments"] as const;
const CONFIRM = "linearlite:evict";
/** Cached threads below which storage pressure raises no alert: the visible rows reload right after an eviction. */
const MIN_EVICTION = 100;

/** Tells the sync leader, in this tab or another, that the user agreed to clear the cached bodies and comments. */
export function confirmEviction(): void {
  const channel = new BroadcastChannel(CONFIRM);
  channel.postMessage(null);
  channel.close();
}

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

/** Of the issues the rows belong to, those whose body the replica holds, which means it holds their whole thread. */
async function heldThreads(store: Store, rows: readonly ServerRow[]): Promise<ReadonlySet<string>> {
  const ids = [...new Set(rows.map((r) => ("issue_id" in r ? r.issue_id : r.id)))];
  const bodies = await store.docs.collection("bodies").getMany(ids);
  return new Set(ids.filter((_, i) => bodies[i]));
}

/**
 * Each slice is its own transaction; a crash between two costs a re-pull, since merging a row again changes nothing.
 * With `held` (pulled bodies and comments), a row for an issue outside it is dropped unless the replica has the row.
 */
export async function mergeServerRows<S extends Stream>(
  store: Store,
  stream: S,
  rows: readonly ServerRow<S>[],
  acked?: readonly Clocks[],
  held?: ReadonlySet<string>,
) {
  const incoming = rows as unknown as readonly Omit<Rows[S], "dirty" | "pending">[];
  const step = rowsPerBatch(store, stream);
  for (let at = 0; at < incoming.length; at += step) {
    const slice = incoming.slice(at, at + step);
    await transact(
      store,
      stream,
      slice.map((row) => row.id),
      (locals) =>
        slice.map((row, i) =>
          held
            ? mergePulled<Rows[S]>(locals[i], row, held.has("issue_id" in row ? (row.issue_id as string) : row.id))
            : mergeIncoming<Rows[S]>(locals[i], row, acked?.[at + i]),
        ),
    );
  }
}

type Loop =
  | { readonly kind: "idle" }
  | { readonly kind: "running"; wake: boolean }
  | { readonly kind: "waiting"; readonly timer: ReturnType<typeof setTimeout> };

type Reason = "start" | "hint" | "dirty" | "online" | "pressure";

type Outgoing = { readonly op: PushOp; readonly key: string };

class Leader {
  private loop: Loop = { kind: "idle" };
  private state: SyncState = EMPTY;
  private head: number | undefined;
  /** The user confirmed clearing the cached bodies and comments, and the loop has not done it yet. */
  private confirmed = false;
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
    // Every tab shows the alert while `pressure` is set. A confirmation from any tab reaches the loop, which
    // evicts after a push, so no page lands rows after the clear.
    this.store.db.onPressure(async () => {
      // kv asks again at each flush while over the cap. With few threads cached there is little to free, so no alert.
      const cached = await this.store.docs.collection("bodies").queryIds({ limit: MIN_EVICTION + 1 });
      if (!this.state.pressure && cached.ids.length > MIN_EVICTION) await this.save({ pressure: true });
    });
    new BroadcastChannel(CONFIRM).onmessage = () => {
      this.confirmed = true;
      this.kick("pressure");
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
    await this.startAtHead();
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

  /**
   * Bodies and comments are not pulled from the start: a replica loads an issue's when it becomes visible
   * (`preloadDetails`), and from here pulls only what changes, for the issues it holds.
   */
  private async startAtHead(): Promise<void> {
    const { caughtUp, cursors } = this.state;
    if (!caughtUp.bodies || !caughtUp.comments) {
      await this.save({ cursors: { ...cursors, bodies: this.head!, comments: this.head! }, caughtUp: { ...caughtUp, bodies: true, comments: true } });
    }
    for (const stream of BACKGROUND) this.mark(stream);
  }

  private mark(stream: Stream): void {
    if (this.marked.has(stream)) return;
    this.marked.add(stream);
    performance.mark(`linearlite:caught-up:${stream}`);
  }

  private stale(stream: Stream): boolean {
    return !this.state.caughtUp[stream] || this.head === undefined || this.state.cursors[stream] < this.head;
  }

  private async page(stream: Stream): Promise<void> {
    const res = await this.pager.page(stream, this.state.cursors[stream]);
    this.checkEpoch(res.epoch);
    if (res.rows.length > 0) await mergeServerRows(this.store, stream, res.rows, undefined, stream === "issues" ? undefined : await heldThreads(this.store, res.rows));
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
    if (this.confirmed) await this.evict();
  }

  /**
   * Frees space for kv's size cap once the user confirmed: drops every body and comment, which are loaded again when
   * their issue is visible or opened. Issues stay. Runs right after a push, and waits while a body or comment still
   * has an unsent edit; the next push tries again.
   */
  private async evict(): Promise<void> {
    const { docs, dirtyBodies, dirtyComments } = this.store;
    if (dirtyBodies.size > 0 || dirtyComments.size > 0) return;
    for (const name of BACKGROUND) {
      // The issues alone can be over the cap; a clear of nothing would still spend a collection id.
      if ((await docs.collection(name).queryIds({ limit: 1 })).ids.length > 0) await docs.collection(name).clear();
    }
    this.confirmed = false;
    await this.save({ pressure: false });
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

/** Ids asked for and not answered with a body: in flight, or the server has none. Not asked again until the page reloads. */
const asked = new Set<string>();

/** Writes the bodies and comments of `ids`, whole threads. Rows join the replica here, unlike a pull's. */
async function fetchDetails(ids: readonly string[]): Promise<DetailResponse> {
  const store = await openStore();
  const res = await request<DetailResponse>(store.user, `/api/detail?${ids.map((id) => `id=${encodeURIComponent(id)}`).join("&")}`);
  if (res.bodies.length > 0) await mergeServerRows(store, "bodies", res.bodies);
  if (res.comments.length > 0) await mergeServerRows(store, "comments", res.comments);
  return res;
}

export const fetchDetail = (id: string) => fetchDetails([id]);

/**
 * Loads the threads of issues that came into view, in requests of up to `MAX_DETAIL_IDS`. It skips those whose body
 * the replica holds, those being asked for and those the server has no body for. A failed request is forgotten, so
 * the ids are asked for again the next time they are seen.
 */
export async function preloadDetails(ids: readonly string[]): Promise<void> {
  const store = await openStore();
  const held = await store.docs.collection("bodies").getMany(ids);
  const wanted = ids.filter((id, i) => !held[i] && !asked.has(id));
  for (let at = 0; at < wanted.length; at += MAX_DETAIL_IDS) {
    const batch = wanted.slice(at, at + MAX_DETAIL_IDS);
    for (const id of batch) asked.add(id);
    try {
      for (const { id } of (await fetchDetails(batch)).bodies) asked.delete(id);
    } catch (err) {
      for (const id of batch) asked.delete(id);
      console.warn("linearlite could not preload details", err);
    }
  }
}

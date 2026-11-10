import { ClosedError, prefixBound, type ChangeEvent, type Db, type Entry } from "@opfs-lsm/kv";
import type {
  BaseCollectionConfig,
  ChangeMessageOrDeleteKeyMessage,
  CollectionConfig,
  InferSchemaOutput,
  PendingMutation,
  SyncConfig,
  UtilsRecord,
} from "@tanstack/db";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  collectionPrefix,
  decodeRowKey,
  encodeRowKey,
  hasPrefix,
  jsonCodec,
  type CollectionPrefix,
  type RowCodec,
  type RowKey,
} from "./keys.js";

export type { RowCodec } from "./keys.js";

/**
 * A TanStack collection config without the parts this adapter owns: it
 * persists every mutation itself and syncs eagerly.
 */
export interface KvCollectionConfig<
  T extends object,
  TSchema extends StandardSchemaV1 = never,
  TKey extends string | number = string | number,
> extends Omit<BaseCollectionConfig<T, TKey, TSchema>, "onInsert" | "onUpdate" | "onDelete" | "syncMode" | "utils"> {
  /** An open kv handle. The caller owns and closes it, and many collections can share it. */
  db: Db;
  /** Names the collection's rows in `db`. Two collections with one name on one db share their rows. */
  name: string;
  /** JSON by default. It must round-trip the rows `schema` outputs. */
  codec?: RowCodec<T>;
}

export interface KvCollectionUtils extends UtilsRecord {
  /**
   * Persist a manual transaction's mutations of this collection as one kv
   * batch. Call it from `createTransaction({ mutationFn })`.
   */
  acceptMutations(transaction: { mutations: ReadonlyArray<PendingMutation<any>> }): Promise<void>;
}

export function kvCollectionOptions<TSchema extends StandardSchemaV1, TKey extends string | number = string | number>(
  config: KvCollectionConfig<InferSchemaOutput<TSchema>, TSchema, TKey> & { schema: TSchema },
): CollectionConfig<InferSchemaOutput<TSchema>, TKey, TSchema, KvCollectionUtils> & {
  id: string;
  utils: KvCollectionUtils;
  schema: TSchema;
};
export function kvCollectionOptions<T extends object, TKey extends string | number = string | number>(
  config: KvCollectionConfig<T, never, TKey> & { schema?: never },
): CollectionConfig<T, TKey, never, KvCollectionUtils> & { id: string; utils: KvCollectionUtils; schema?: never };
export function kvCollectionOptions(
  config: KvCollectionConfig<Row, StandardSchemaV1>,
): CollectionConfig<Row, RowKey, StandardSchemaV1, KvCollectionUtils> & { id: string; utils: KvCollectionUtils } {
  const { db, name, codec = jsonCodec<Row>(), ...base } = config;
  const prefix = collectionPrefix(name);
  const id = base.id ?? `opfs-lsm:${name}`;
  let current: Run | undefined;
  let owner: unknown;

  const sync: SyncConfig<Row, RowKey>["sync"] = (params) => {
    owner = params.collection;
    const run = new Run(db, prefix, codec, params);
    current = run;
    run.start();
    return () => {
      run.stop();
      if (current === run) current = undefined;
    };
  };

  const persist = async (mutations: ReadonlyArray<PendingMutation<any>>): Promise<void> => {
    // By instance, not id: the same `name` on two dbs yields the same default id.
    const mine = mutations.filter((m) => m.collection === owner);
    if (mine.length === 0) return;
    await db.batch((tx) => {
      for (const m of mine) {
        const key = encodeRowKey(prefix, m.key as RowKey);
        if (m.type === "delete") tx.delete(key);
        else tx.put(key, codec.encode(m.modified));
      }
    });
    // kv announced the record before batch resolved, so a live run already
    // committed it. A loading run commits it with its snapshot; wait for that,
    // so the optimistic row is not dropped before the synced one shows.
    await current?.settled();
  };

  const handler = ({ transaction }: { transaction: { mutations: ReadonlyArray<PendingMutation<any>> } }) =>
    persist(transaction.mutations);

  return {
    ...base,
    id,
    sync: { sync, rowUpdateMode: "full" },
    onInsert: handler,
    onUpdate: handler,
    onDelete: handler,
    utils: { acceptMutations: (transaction) => persist(transaction.mutations) },
  };
}

type Row = Record<string, unknown>;
type SyncParams = Parameters<SyncConfig<Row, RowKey>["sync"]>[0];
type Append = Extract<ChangeEvent, { kind: "append" }>;

/**
 * loading: a snapshot read is in flight, and appends wait in `buffer` until
 * its seq is known. `done` resolves when the load commits or the run stops.
 * live: appends commit as they arrive. stopped: nothing more is written.
 */
type Phase = Loading | { readonly kind: "live" } | { readonly kind: "stopped" };
type Loading = { readonly kind: "loading"; readonly buffer: Append[]; readonly done: PromiseWithResolvers<void> };

/**
 * One TanStack sync run. The kv change feed is the only thing that writes
 * synced rows, own writes included. `through` is the highest seq this run has
 * handed to TanStack.
 */
class Run {
  private phase: Phase = { kind: "stopped" };
  private through = 0;
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly db: Db,
    private readonly prefix: CollectionPrefix,
    private readonly codec: RowCodec<Row>,
    private readonly p: SyncParams,
  ) {}

  /** Subscribe before the read, so no record lands between the snapshot and the feed. */
  start(): void {
    try {
      this.unsubscribe = this.db.changes((event) => this.onChange(event));
    } catch (err) {
      this.p.fail(err);
      return;
    }
    this.load();
  }

  stop(): void {
    const was = this.phase;
    this.phase = { kind: "stopped" };
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (was.kind === "loading") was.done.resolve();
  }

  /** Resolves once this run's synced rows include every record announced so far. */
  settled(): Promise<void> {
    return this.phase.kind === "loading" ? this.phase.done.promise : Promise.resolve();
  }

  private onChange(event: ChangeEvent): void {
    switch (event.kind) {
      case "append":
        if (this.phase.kind === "loading") this.phase.buffer.push(event);
        else if (this.phase.kind === "live" && event.seq > this.through) this.commit(undefined, [event]);
        return;
      case "gap":
        // A load in flight may have pinned its view before the jump, so it restarts.
        if (this.phase.kind !== "stopped" && event.through > this.through) this.load();
        return;
      case "ingest":
        return;
      case "closed":
        this.stop();
        this.p.fail(new ClosedError("database is closed"));
        return;
    }
  }

  /** A snapshot replaces the synced rows, so the first load, a gap and a restarted run all read the same way. */
  private load(): void {
    const prev = this.phase.kind === "loading" ? this.phase : undefined;
    const mine: Loading = {
      kind: "loading",
      buffer: prev?.buffer ?? [],
      done: prev?.done ?? Promise.withResolvers<void>(),
    };
    this.phase = mine;
    void this.db
      .view(async (snap) => {
        const rows: Entry[] = [];
        for await (const entry of snap.range(prefixBound(this.prefix))) rows.push(entry);
        return { at: snap.walHead, rows };
      })
      .then(
        (snapshot) => {
          if (this.phase !== mine) return;
          this.commit(
            snapshot,
            mine.buffer.filter((e) => e.seq > snapshot.at),
          );
          if (this.phase !== mine) return;
          this.phase = { kind: "live" };
          this.p.markReady();
          mine.done.resolve();
        },
        (err: unknown) => {
          if (this.phase !== mine) return;
          this.stop();
          this.p.fail(err);
        },
      );
  }

  /** One sync transaction. `rowUpdateMode: "full"` makes an update an upsert, so no write needs to know whether its row exists. */
  private commit(snapshot: { readonly at: number; readonly rows: readonly Entry[] } | undefined, events: readonly Append[]): void {
    try {
      const writes: ChangeMessageOrDeleteKeyMessage<Row, RowKey>[] = [];
      for (const row of snapshot?.rows ?? []) writes.push({ type: "update", value: this.codec.decode(row.value) });
      for (const event of events) {
        for (const op of event.ops) {
          if (!hasPrefix(this.prefix, op.key)) continue;
          writes.push(
            op.type === "put"
              ? { type: "update", value: this.codec.decode(op.value) }
              : { type: "delete", key: decodeRowKey(this.prefix, op.key) },
          );
        }
      }
      if (snapshot || writes.length > 0) {
        this.p.begin(snapshot ? { snapshot: true } : undefined);
        for (const write of writes) this.p.write(write);
        this.p.commit();
      }
    } catch (err) {
      this.stop();
      this.p.fail(err);
      return;
    }
    this.through = Math.max(this.through, snapshot?.at ?? 0, events.at(-1)?.seq ?? 0);
  }
}

import { BTreeIndex, createCollection, createIndexedDB, indexedDBCollectionOptions, type Collection, type PendingMutation } from "@tanstack/db";
import { STATUSES, stored, type Issue, type StatusCode } from "../domain/model.ts";
import { STORES, type Stream } from "../domain/stores.ts";
import type { Backend, BackendPath, CollectionRows, StatusCounts, StoreName, StoreRows } from "../model/backend.ts";
import type { IssueFilter } from "../model/filter.ts";
import { recount, type Pause } from "./recount.ts";

const PATH: BackendPath = {
  name: "indexeddb",
  loads: "indexedDBCollectionOptions on createIndexedDB, eager (its only mode): every row of every store is read at open; one in-memory BTree index per field the stores index",
  writes: "rows read from memory and merged, then written with the collection's acceptMutations: one IndexedDB readwrite transaction per call, serialized within the tab",
  counts: "one pass over the issues in memory with the filter, counted again after changes",
  deep: "no anchor: a deep window is one query from the top, over rows already in memory",
  pressure: "none: no pressure API, nothing is evicted",
  tabs: "BroadcastChannel between tabs; transact reads memory, so it is atomic within a tab only",
};

/** A row as stored: TanStack adds `$`-prefixed virtual properties to the rows it hands out. */
const plain = <T extends object>(row: T | undefined): T | undefined =>
  row && (Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith("$"))) as T);

const NAMES = Object.keys(STORES) as StoreName[];

/** Rows per pause of a count that no one waits on: about a millisecond of filtering. */
const COUNT_SLICE = 20_000;

export type IndexedDbOptions = {
  /** Whether the page is hidden, so a recount runs without pausing. Default: never. */
  readonly hidden?: () => boolean;
  /** A factory other than `indexedDB`, for tests. */
  readonly idbFactory?: IDBFactory;
};

/** The replica in the IndexedDB database `name`, every row loaded. */
export async function openIndexedDbBackend(name: string, { hidden = () => false, idbFactory }: IndexedDbOptions = {}): Promise<Backend> {
  const idb = await createIndexedDB({ name, version: 1, stores: NAMES, idbFactory });
  const collections = Object.fromEntries(
    NAMES.map((store) => {
      const collection = createCollection(
        indexedDBCollectionOptions<{ id: string }, string>({
          db: idb,
          name: store,
          getKey: (row) => row.id,
          ...(store === "issues" && { defaultStringCollation: { stringSort: "lexical" } }),
        }),
      );
      const fields = new Set(Object.values<{ on: string | readonly string[] }>(STORES[store].indexes).flatMap((index) => [index.on].flat()));
      // An index serves a query only when its collation is the query's, which the issues' collection sets.
      const options = store === "issues" ? { compareOptions: { direction: "asc" as const, nulls: "first" as const, stringSort: "lexical" as const } } : undefined;
      for (const field of fields) collection.createIndex((row) => (row as unknown as Record<string, never>)[field], { indexType: BTreeIndex, options });
      return [store, collection];
    }),
  ) as unknown as { [S in StoreName]: Collection<CollectionRows[S], string> };
  await Promise.all(Object.values(collections).map((c) => c.preload()));

  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(run: () => Promise<T>): Promise<T> => {
    const result = queue.then(run);
    queue = result.catch(() => {});
    return result;
  };

  const countIssues = async (filter: IssueFilter, pause?: Pause): Promise<StatusCounts> => {
    const counts = STATUSES.map(() => 0);
    const needle = filter.q.toLowerCase();
    let seen = 0;
    for (const i of collections.issues.values()) {
      if (
        !i.deleted &&
        (filter.status.length === 0 || filter.status.includes(i.status)) &&
        (filter.priority.length === 0 || filter.priority.includes(i.priority)) &&
        i.title.toLowerCase().includes(needle)
      ) {
        counts[i.status as StatusCode]!++;
      }
      if (pause && ++seen % COUNT_SLICE === 0) await pause();
    }
    return counts;
  };
  const watchIssues = <T>(count: (pause?: Pause) => Promise<T>, emit: (value: T) => void) =>
    recount(
      (onChange) => {
        const subscription = collections.issues.subscribeChanges(onChange);
        return () => subscription.unsubscribe();
      },
      count,
      emit,
      hidden,
    );

  return {
    path: PATH,
    collection: <S extends StoreName>(store: S) => collections[store] as Collection<CollectionRows[S], string>,
    read: async (store, ids) => ids.map((id) => plain(collections[store].get(id)) as StoreRows[typeof store] | undefined),
    transact: <S extends StoreName, T extends { readonly id: string }>(
      store: S,
      items: readonly T[],
      merge: (local: StoreRows[S] | undefined, item: T) => StoreRows[S] | null | undefined,
    ) =>
      serialized(async () => {
        const collection = collections[store] as unknown as Collection<{ id: string }, string>;
        const mutations: PendingMutation[] = [];
        for (const item of items) {
          const local = plain(collection.get(item.id));
          const merged = merge(local as StoreRows[S] | undefined, item);
          if (merged === undefined || (merged === null && !local)) continue;
          const row = merged === null ? local : store === "issues" ? stored(merged as Issue) : merged;
          mutations.push({ collection, type: merged === null ? "delete" : local ? "update" : "insert", modified: row } as unknown as PendingMutation);
        }
        if (mutations.length > 0) await collection.utils.acceptMutations({ mutations });
      }),
    clear: (stream: Stream) => collections[stream].utils.clearObjectStore(),
    watchCounts: (filter, emit) => watchIssues((pause) => countIssues(filter, pause), emit),
    watchTotal: (filter, emit) =>
      watchIssues(async (pause) => (await countIssues(filter, pause)).reduce((a, b) => a + b, 0), emit),
    async close() {
      await Promise.all(Object.values(collections).map((c) => c.cleanup()));
      idb.close();
    },
  };
}

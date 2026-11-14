import { createBrowserWASQLitePersistence, persistedCollectionOptions, type BrowserWASQLiteDatabase } from "@tanstack/browser-db-sqlite-persistence";
import { createCollection, type Collection, type PendingMutation } from "@tanstack/db";
import { STATUSES, stored, type Issue } from "../domain/model.ts";
import { STORES, type Stream } from "../domain/stores.ts";
import type { Anchor, Backend, BackendPath, CollectionRows, SortValue, StatusCounts, StoreName, StoreRows } from "../model/backend.ts";
import type { IssueFilter } from "../model/filter.ts";
import { ORDER } from "../model/query.ts";
import { recount } from "./recount.ts";

export const SQLITE_PATH: BackendPath = {
  name: "sqlite",
  loads:
    "persistedCollectionOptions (local-only) on createBrowserWASQLitePersistence: wa-sqlite on OPFS (OPFSCoopSyncVFS) in a dedicated WebWorker; issues, bodies and comments on demand, sync eager; each STORES index is one SQLite expression index over the fields TanStack's SQL reads, with no text index. A load reads every row its where matches in a BEGIN IMMEDIATE transaction, then sorts and pages them in JS (TanStack sends no LIMIT)",
  writes:
    "under a Web Lock per store: rows read by key with SQL and merged, then written with the collection's acceptMutations in one SQLite transaction; every row this tab writes stays in memory",
  counts: "one SQL count grouped by status; with no priority filter or search it reads only the byStatus index, otherwise the rows",
  deep: "anchor: one SQL statement walks the sort's index to row n and counts the rows before it; title lists are not anchored",
  pressure: "none: nothing is evicted",
  tabs: "one tab: TanStack's single-tab coordinator; another tab's writes reach storage under the same locks but not this tab's views",
};

const NAMES = Object.keys(STORES) as StoreName[];

/**
 * A row field as TanStack's SQL reads it from the stored JSON, tagged values first. The indexes use this exact
 * expression, so SQLite serves TanStack's loads and the counts here from them.
 */
const field = (name: string) => `(CASE json_extract(value, '$.${name}.__tanstack_db_persisted_type__')
  WHEN 'bigint' THEN CAST(json_extract(value, '$.${name}.value') AS NUMERIC)
  WHEN 'date' THEN json_extract(value, '$.${name}.value')
  WHEN 'string' THEN json_extract(value, '$.${name}.value')
  WHEN 'Temporal.Instant' THEN json_extract(value, '$.${name}.order')
  WHEN 'Temporal.PlainDate' THEN json_extract(value, '$.${name}.order')
  WHEN 'nan' THEN NULL WHEN 'infinity' THEN NULL WHEN '-infinity' THEN NULL
  ELSE json_extract(value, '$.${name}') END)`;

/** The live issues under `filter`'s status, priority and search, as a SQL condition and its parameters. */
function where(filter: IssueFilter): { sql: string; params: string[] } {
  const terms = [`${field("deleted")} = 0`];
  if (filter.status.length > 0) terms.push(`${field("status")} IN (${filter.status.join(",")})`);
  if (filter.priority.length > 0) terms.push(`${field("priority")} IN (${filter.priority.join(",")})`);
  // The list's ilike as SQLite runs it: LOWER folds ASCII letters only.
  if (filter.q !== "") terms.push(`instr(LOWER(${field("title")}), LOWER(?)) > 0`);
  return { sql: terms.join(" AND "), params: filter.q !== "" ? [filter.q] : [] };
}

/**
 * Whether a deep window of the list under `filter` can start at a sort value: the list shows every live issue, and
 * SQLite orders the values as TanStack does. Titles do not: SQLite orders strings by code point and TanStack by
 * UTF-16 unit.
 */
const anchors = (filter: IssueFilter) => filter.status.length === 0 && filter.priority.length === 0 && filter.q === "" && filter.sort !== "title";

type Change = { readonly type: "insert" | "delete"; readonly key: string; readonly modified?: object; readonly original?: object };

export type SqliteOptions = {
  /** Names the replica's Web Locks, so tabs over the same database share them. */
  readonly name: string;
  /** Whether the page is hidden, so a recount runs without pausing. Default: never. */
  readonly hidden?: () => boolean;
};

/** The replica in `database`, with the sync row loaded. The caller opened `database` and closes it. */
export async function openSqliteBackend(database: BrowserWASQLiteDatabase, { name, hidden = () => false }: SqliteOptions): Promise<Backend> {
  const persistence = createBrowserWASQLitePersistence({ database });
  const collections = Object.fromEntries(
    NAMES.map((store) => [
      store,
      createCollection(
        persistedCollectionOptions<{ id: string }, string>({
          id: store,
          getKey: (row) => row.id,
          persistence,
          schemaVersion: 1,
          syncMode: STORES[store].load,
          ...(store === "issues" && { defaultStringCollation: { stringSort: "lexical" } }),
        }),
      ),
    ]),
  ) as unknown as { [S in StoreName]: Collection<CollectionRows[S], string> };
  // A collection has registered its table once ready; the indexes go on that table.
  await Promise.all(Object.values(collections).map((c) => new Promise<void>((resolve) => c.onFirstReady(resolve))));
  const registry = await database.execute<{ collection_id: StoreName; table_name: string }>("SELECT collection_id, table_name FROM collection_registry");
  const tables = Object.fromEntries(registry.map((r) => [r.collection_id, `"${r.table_name}"`])) as Record<StoreName, string>;
  for (const store of NAMES) {
    // TanStack reads `id` from the JSON, not from the key column, so a lookup by id needs its own index.
    const indexes: Record<string, { on: string | readonly string[] }> = { id: { on: "id" }, ...STORES[store].indexes };
    for (const [index, { on }] of Object.entries(indexes)) {
      await database.execute(`CREATE INDEX IF NOT EXISTS "${store}_${index}" ON ${tables[store]} (${[on].flat().map(field).join(", ")})`);
    }
  }
  await collections.sync.preload();

  const readStored = async (store: StoreName, ids: readonly string[]) => {
    const rows = await database.execute<{ key: string; value: string }>(
      `SELECT key, value FROM ${tables[store]} WHERE key IN (SELECT value FROM json_each(?))`,
      [JSON.stringify(ids.map((id) => `s:${id}`))],
    );
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    return ids.map((id) => {
      const json = byKey.get(`s:${id}`);
      return json === undefined ? undefined : (JSON.parse(json) as { id: string });
    });
  };
  /** Writes the changes `plan` makes, under the store's lock in every tab, so the rows it reads stay current until they land. */
  const write = async (store: StoreName, plan: () => Promise<Change[]>): Promise<void> => {
    await navigator.locks.request(`linearlite-sqlite:${name}:${store}`, async () => {
      const collection = collections[store];
      const changes = await plan();
      if (changes.length === 0) return;
      const mutations = changes.map((c) => ({ ...c, collection, mutationId: crypto.randomUUID() }) as unknown as PendingMutation);
      await (collection.utils as unknown as { acceptMutations(t: { mutations: PendingMutation[] }): Promise<void> }).acceptMutations({ mutations });
    });
  };

  const issues = tables.issues;
  const countByStatus = async (filter: IssueFilter): Promise<StatusCounts> => {
    const { sql, params } = where(filter);
    const rows = await database.execute<{ s: number; n: number }>(`SELECT ${field("status")} AS s, count(*) AS n FROM ${issues} WHERE ${sql} GROUP BY s`, params);
    const counts = STATUSES.map(() => 0);
    for (const { s, n } of rows) counts[s] = n;
    return counts;
  };
  /** The condition on a live issue that sorts strictly before the value that follows it. */
  const before = (filter: IssueFilter) => `${field("deleted")} = 0 AND ${field(ORDER[filter.sort])} ${filter.dir === "desc" ? ">" : "<"}`;
  const watchIssues = <T>(count: () => Promise<T>, emit: (value: T) => void) =>
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
    path: SQLITE_PATH,
    collection: <S extends StoreName>(store: S) => collections[store] as Collection<CollectionRows[S], string>,
    read: (store, ids) => readStored(store, ids) as Promise<ReadonlyArray<StoreRows[typeof store] | undefined>>,
    transact: (store, items, merge) =>
      write(store, async () => {
        const locals = (await readStored(store, items.map((item) => item.id))) as ReadonlyArray<StoreRows[typeof store] | undefined>;
        return items.flatMap((item, i): Change[] => {
          const local = locals[i];
          const merged = merge(local, item);
          if (merged === undefined || (merged === null && !local)) return [];
          if (merged === null) return [{ type: "delete", key: item.id, original: local }];
          // TanStack stores an `update` merged into the stored row and an `insert` in its place, which drops the keys a merge left out.
          return [{ type: "insert", key: item.id, modified: store === "issues" ? stored(merged as Issue) : merged }];
        });
      }),
    clear: (stream: Stream) =>
      write(stream, async () => {
        const rows = await database.execute<{ key: string; value: string }>(`SELECT key, value FROM ${tables[stream]}`);
        return rows.map((r): Change => ({ type: "delete", key: r.key.slice(2), original: JSON.parse(r.value) }));
      }),
    watchCounts: (filter, emit) => watchIssues(() => countByStatus(filter), emit),
    watchTotal: (filter, emit) => watchIssues(async () => (await countByStatus(filter)).reduce((a, b) => a + b, 0), emit),
    anchor: (filter) =>
      anchors(filter)
        ? {
            async locate(n): Promise<Anchor | undefined> {
              const [row] = await database.execute<Anchor>(
                `WITH at AS (SELECT ${field(ORDER[filter.sort])} AS v FROM ${issues} WHERE ${field("deleted")} = 0 ORDER BY v ${filter.dir} LIMIT 1 OFFSET ?)
                 SELECT v AS value, (SELECT count(*) FROM ${issues} WHERE ${before(filter)} at.v) AS base FROM at`,
                [n],
              );
              return row;
            },
            watchBase: (value: SortValue, emit) =>
              watchIssues(async () => (await database.execute<{ n: number }>(`SELECT count(*) AS n FROM ${issues} WHERE ${before(filter)} ?`, [value]))[0]!.n, emit),
          }
        : undefined,
    async close() {
      await Promise.all(Object.values(collections).map((c) => c.cleanup()));
    },
  };
}

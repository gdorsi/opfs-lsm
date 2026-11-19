import { collection, defineSchema, openDocStore, type Cursor, type DocStore, type Scalar } from "@opfs-lsm/docstore";
import type { Db } from "@opfs-lsm/kv";
import { docstoreCollectionOptions } from "@opfs-lsm/tanstack-db";
import { createCollection, type Collection } from "@tanstack/db";
import { Body, Comment, priorityOrder, STATUSES, stored, StoredIssue, SyncState, type Issue, type StatusCode } from "../domain/model.ts";
import { STORES, type Stream } from "../domain/stores.ts";
import type { Anchor, Backend, CollectionRows, StoreName, StoreRows } from "../model/backend.ts";
import type { IssueFilter, SortField } from "../model/filter.ts";
import { ORDER } from "../model/query.ts";
import { recount, type Pause } from "./recount.ts";

/** The reads each issue index serves are in DESIGN.md, "Indexes". */
export const schema = defineSchema({
  version: 5,
  collections: {
    issues: collection(StoredIssue)
      .index("byCreated", ["deleted", "created"])
      .index("byTitle", ["deleted", "title"])
      .index("byPriority", ["deleted", "priority", "priorityOrder"])
      .text("byStatus", ["deleted", "status", "statusOrder"], "title")
      .text("search", ["deleted", "modified"], "title")
      .index("pending", "pending"),
    bodies: collection(Body).index("pending", "pending"),
    comments: collection(Comment).index("byIssue", "issue_id").index("pending", "pending"),
    sync: collection(SyncState),
  },
  drop: ["outbox"],
});

export type Docs = DocStore<typeof schema>;
const issueDocs = (docs: Docs) => docs.collection("issues");
type IssueDocs = ReturnType<typeof issueDocs>;
type Snap = Parameters<Parameters<IssueDocs["view"]>[0]>[0];
type IssueQuery = Parameters<IssueDocs["count"]>[0];

/**
 * The most kv ops one slice of `transact` writes. kv caps a batch by bytes, not ops: 8 MiB, counting 256 bytes per op
 * (docstore README, "Limits").
 */
const KV_BATCH_OPS = 10_000;
/** Cached threads below which a full storage asks nothing: the visible rows reload right after an eviction. */
const MIN_EVICTION = 100;

type Transact<T> = (ids: readonly string[], merge: (rows: ReadonlyArray<T | undefined>) => ReadonlyArray<object | null | undefined>) => Promise<void>;

export type KvBackend = Backend & {
  /** The docstore under the collections, for tests that check what it stores. */
  readonly docs: Docs;
};

export type KvOptions = {
  /** Whether the page is hidden, so a recount runs without pausing. Default: never. */
  readonly hidden?: () => boolean;
};

/** The replica in `db`, with the sync row loaded. The caller opened `db` and closes it. */
export async function openKvBackend(db: Db, { hidden = () => false }: KvOptions = {}): Promise<KvBackend> {
  const docs = await openDocStore(db, schema);
  const collections = {
    issues: createCollection(
      docstoreCollectionOptions({ collection: issueDocs(docs), syncMode: STORES.issues.load, defaultStringCollation: { stringSort: "lexical" } }),
    ),
    bodies: createCollection(docstoreCollectionOptions({ collection: docs.collection("bodies"), syncMode: STORES.bodies.load })),
    comments: createCollection(docstoreCollectionOptions({ collection: docs.collection("comments"), syncMode: STORES.comments.load })),
    sync: createCollection(docstoreCollectionOptions({ collection: docs.collection("sync"), syncMode: STORES.sync.load })),
  };
  await collections.sync.preload();
  const issues = issueDocs(docs);
  /**
   * The most rows of `store` one slice writes within `KV_BATCH_OPS`. A row write is the row plus, per index,
   * at most a delete of its old entry and a put of its new one; every index here holds at most one entry per row.
   */
  const rowsPerBatch = (store: StoreName) => Math.floor(KV_BATCH_OPS / (1 + 2 * docs.collection(store).indexes.size));
  const recountIssues = <T>(count: (pause?: Pause) => Promise<T>, emit: (value: T) => void) =>
    recount(
      (onChange) =>
        issues.changes((event) => {
          if (event.kind !== "closed") onChange();
        }),
      count,
      emit,
      hidden,
    );

  return {
    docs,
    collection: <S extends StoreName>(store: S) => collections[store] as unknown as Collection<CollectionRows[S], string>,
    read: (store, ids) => docs.collection(store).getMany(ids),
    async transact(store, items, merge) {
      const write = collections[store].utils.transact as unknown as Transact<StoreRows[typeof store]>;
      const step = rowsPerBatch(store);
      for (let at = 0; at < items.length; at += step) {
        const slice = items.slice(at, at + step);
        await write(
          slice.map((item) => item.id),
          (rows) =>
            slice.map((item, i) => {
              const row = merge(rows[i], item);
              return store === "issues" && row ? stored(row as Issue) : row;
            }),
        );
      }
    },
    async clear(stream: Stream) {
      // A clear spends a collection id, so a stream already empty is left as it is.
      const rows = docs.collection(stream);
      if ((await rows.queryIds({ limit: 1 })).ids.length > 0) await rows.clear();
    },
    watchCounts: (filter, emit) => recountIssues((pause) => countByStatus(issues, filter, pause), emit),
    watchTotal: (filter, emit) => recountIssues((pause) => countTotal(issues, filter, pause), emit),
    anchor: (filter) =>
      anchors(filter)
        ? {
            locate: (n) => locate(issues, filter, n),
            watchBase: (value, emit) => recountIssues(() => countBefore(issues, filter, value), emit),
          }
        : undefined,
    // kv asks again after a flush while its reserve does not fit. With few threads cached there is little to free, so no alert.
    onStorageFull: (ask) =>
      db.onStorageFull(async () => {
        const cached = await docs.collection("bodies").queryIds({ limit: MIN_EVICTION + 1 });
        if (cached.ids.length > MIN_EVICTION) await ask();
      }),
    async close() {
      await Promise.all(Object.values(collections).map((c) => c.cleanup()));
    },
  };
}

const ALL = STATUSES.map((_, code) => code as StatusCode);
const NON_WORD = /[^\p{L}\p{M}\p{N}]+/u;

/** docstore's text words: a `match` keeps the titles holding each of them inside one word. */
const wordsOf = (text: string) =>
  text
    .normalize("NFC")
    .toLowerCase()
    .split(NON_WORD)
    .filter((w) => w !== "");

/**
 * The word of a query that is one plain word, else undefined. Such a query is decided by a text index's entries
 * alone: the index normalizes titles to NFC and `ilike` does not, so this agrees with the list for titles stored in
 * NFC, as typed text is.
 */
function plainWord(q: string): string | undefined {
  const words = wordsOf(q);
  return words.length === 1 && words[0] === q.toLowerCase() ? words[0] : undefined;
}

/** Documents a search reads between two pauses. */
const SEARCH_PAGE = 256;

/**
 * The live issues under `filter` whose titles contain the query, as the list's `ilike` decides. The text index
 * narrows them to the titles holding every word of the query; the substring test makes it exact. It reads the
 * documents a page at a time and pauses between pages.
 */
async function searched(snap: Snap, filter: IssueFilter, pause?: Pause): Promise<Issue[]> {
  const words = wordsOf(filter.q);
  const needle = filter.q.toLowerCase();
  const out: Issue[] = [];
  for (let after: Cursor | undefined; ; ) {
    const { docs, next } = await snap.query({
      index: "search",
      eq: [false],
      limit: SEARCH_PAGE,
      ...(words.length > 0 && { match: words.join(" ") }),
      ...(after !== undefined && { after }),
    });
    out.push(
      ...docs.filter(
        (i) =>
          (filter.status.length === 0 || filter.status.includes(i.status)) &&
          (filter.priority.length === 0 || filter.priority.includes(i.priority)) &&
          i.title.toLowerCase().includes(needle),
      ),
    );
    if (next === undefined) return out;
    after = next;
    await pause?.();
  }
}

/**
 * Live issues under `filter` per status, indexed by status code; a status the filter leaves out counts 0. It counts
 * index entries and reads no document, unless the query is more than one plain word or comes with a priority
 * filter: then it reads the documents the text index matches. Without `pause` the statuses are counted at once.
 */
function countByStatus(issues: IssueDocs, filter: IssueFilter, pause?: Pause): Promise<number[]> {
  return issues.view(async (snap) => {
    const counts = ALL.map(() => 0);
    const statuses = filter.status.length > 0 ? filter.status : ALL;
    const word = plainWord(filter.q);
    if (filter.q !== "" && (word === undefined || filter.priority.length > 0)) {
      for (const i of await searched(snap, filter, pause)) counts[i.status]!++;
      return counts;
    }
    const count = async (s: StatusCode) => {
      const parts =
        filter.priority.length === 0
          ? [snap.count({ index: "byStatus", eq: [false, s], ...(word !== undefined && { match: word }) })]
          : filter.priority.map((p) =>
              snap.count({ index: "byPriority", eq: [false, p], gte: priorityOrder(p, s, 0), lt: priorityOrder(p, s + 1, 0) }),
            );
      counts[s] = (await Promise.all(parts)).reduce((a, b) => a + b, 0);
    };
    if (!pause) await Promise.all(statuses.map(count));
    else {
      for (const s of statuses) {
        await count(s);
        await pause();
      }
    }
    return counts;
  });
}

/** Live issues under `filter`. */
async function countTotal(issues: IssueDocs, filter: IssueFilter, pause?: Pause): Promise<number> {
  return (await countByStatus(issues, filter, pause)).reduce((a, b) => a + b, 0);
}

/**
 * The index of each sort. It leads with `deleted`, so `eq: [false]` lists every live issue by its sort value
 * (`ORDER`). Issues with the same value come in the index's order, not the list's. `byPriority` and `byStatus` hold
 * the code before the sort value: the value leads with the same code, so the order is the same.
 */
const SORT_INDEX = {
  modified: "search",
  created: "byCreated",
  title: "byTitle",
  priority: "byPriority",
  status: "byStatus",
} as const satisfies Record<SortField, string>;

/** The priority or status code a sort value leads with (`stored`), which that sort's index holds before the value. */
const codeOf = (filter: IssueFilter, value: Scalar): number | undefined =>
  filter.sort === "priority" ? Math.floor((value as number) / 1e14) : filter.sort === "status" ? Number((value as string)[0]) : undefined;

/**
 * Whether a deep window of the list under `filter` can start at a sort value: the list shows every live issue, and
 * its sort index orders the values as the list does. Titles do not: the index orders strings by code point and
 * TanStack by UTF-16 unit, and the two disagree between a character past U+FFFF and one from U+E000 to U+FFFF.
 */
const anchors = (filter: IssueFilter) => filter.status.length === 0 && filter.priority.length === 0 && filter.q === "" && filter.sort !== "title";

/** Every live issue by sort value, or only those whose sort value passes `bound`. */
const inOrder = (filter: IssueFilter, bound: { readonly gt?: Scalar; readonly lt?: Scalar } = {}) =>
  ({ index: SORT_INDEX[filter.sort], eq: [false], ...(filter.dir === "desc" && { reverse: true }), ...bound }) as IssueQuery;

/** Live issues that sort strictly before `value` in a list that `anchors`. Reads index entries only. */
async function countBefore(issues: Pick<Snap, "count">, filter: IssueFilter, value: Scalar): Promise<number> {
  const side = filter.dir === "desc" ? "gt" : "lt";
  const code = codeOf(filter, value);
  if (code === undefined) return issues.count(inOrder(filter, { [side]: value }));
  const [codes, within] = await Promise.all([
    issues.count(inOrder(filter, { [side]: code })),
    issues.count({ index: SORT_INDEX[filter.sort], eq: [false, code], [side]: value } as IssueQuery),
  ]);
  return codes + within;
}

/** Rows before row `n` whose documents `locate` reads to count the rows tied with it. */
const NEAR = 64;

/**
 * The anchor of row `n` of a list that `anchors`, or undefined if the list is shorter. It walks `n` index entries
 * without their documents, then reads rows `n - 64` to `n`: the rows tied with row `n` among them are the rows
 * between the anchor's `base` and `n`. A tie that runs past them is counted from the index.
 */
function locate(issues: IssueDocs, filter: IssueFilter, n: number): Promise<Anchor | undefined> {
  return issues.view(async (snap) => {
    const skip = Math.max(0, n - NEAR);
    const { next } = skip > 0 ? await snap.queryIds({ ...inOrder(filter), limit: skip }) : {};
    if (skip > 0 && next === undefined) return undefined;
    const { docs } = await snap.query({ ...inOrder(filter), limit: n - skip + 1, ...(next !== undefined && { after: next }) });
    if (docs.length < n - skip + 1) return undefined;
    const field = ORDER[filter.sort];
    const value = docs.at(-1)![field];
    let ties = 0;
    while (ties < docs.length - 1 && docs[docs.length - 2 - ties]![field] === value) ties++;
    const base = skip > 0 && ties === docs.length - 1 ? await countBefore(snap, filter, value) : n - ties;
    return { value, base };
  });
}

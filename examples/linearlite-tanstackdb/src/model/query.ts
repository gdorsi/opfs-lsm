import { and, createLiveQueryCollection, eq, gte, ilike, inArray, lte, type Collection, type InitialQueryBuilder, type Ref } from "@tanstack/db";
import type { Body, Comment, StatusCode, StoredIssue, Synced, SyncState } from "../domain/model.ts";
import type { SortValue } from "./backend.ts";
import type { IssueFilter, SortField } from "./filter.ts";

type Issues = Collection<StoredIssue, string>;

/**
 * `ilike` has no escape character, so `%` and `_` in a query would act as wildcards. Those queries are matched by a
 * filter function instead, which TanStack cannot optimize. Every other query stays a plain `ilike`.
 */
const isLiteralOnly = (q: string) => !/[%_]/.test(q);

const CODES = [0, 1, 2, 3, 4];

/**
 * What each sort orders by. Priority and status sort on keys unique per issue (`stored`), so the rows TanStack loads
 * as tied with a window's last row are one or two, not a fifth of the issues.
 */
export const ORDER = {
  modified: "modified",
  created: "created",
  title: "title",
  priority: "priorityOrder",
  status: "statusOrder",
} as const satisfies Record<SortField, keyof StoredIssue>;

/**
 * The filter as a `where`. Tombstones are always out. Under the priority or status sort, the field is pinned to every
 * code when no filter is: the sort's index leads with the field, and is read one range per code.
 */
function matches(i: Ref<StoredIssue>, filter: IssueFilter, status?: StatusCode) {
  const statuses = filter.status.length > 0 ? filter.status : filter.sort === "status" ? CODES : [];
  const priorities = filter.priority.length > 0 ? filter.priority : filter.sort === "priority" && status === undefined ? CODES : [];
  const terms = [
    eq(i.deleted, false),
    ...(status !== undefined ? [eq(i.status, status)] : statuses.length > 0 ? [inArray(i.status, [...statuses])] : []),
    ...(priorities.length > 0 ? [inArray(i.priority, [...priorities])] : []),
    ...(filter.q !== "" && isLiteralOnly(filter.q) ? [ilike(i.title, `%${filter.q}%`)] : []),
  ];
  const [first, second, ...rest] = terms;
  return second === undefined ? first! : and(first!, second, ...rest);
}

/** Issues under the filter, as a query ready for `orderBy`, `select` or `groupBy`. */
export function filtered(q: InitialQueryBuilder, issues: Issues, filter: IssueFilter, status?: StatusCode) {
  const base = q.from({ i: issues }).where(({ i }) => matches(i, filter, status));
  if (filter.q === "" || isLiteralOnly(filter.q)) return base;
  const needle = filter.q.toLowerCase();
  return base.fn.where(({ i }) => i.title.toLowerCase().includes(needle));
}

/**
 * A window of the list: `limit` rows, `offset` rows past the first issue whose sort value is `from` or sorts after it.
 * Two windows that differ only in `offset` and `limit` are one live query, which `useLiveQuery` moves in place.
 */
export type ListWindow = { readonly from?: SortValue; readonly offset: number; readonly limit: number };

/**
 * Whether the filter's title search matches with a function, which TanStack can neither hash nor move in place: a
 * screen builds that query once (`windowQuery`) and moves its window with `setWindow`.
 */
export const needsFilterFunction = (filter: IssueFilter) => !isLiteralOnly(filter.q);

/** Issues under the filter in its order, from `from` on: a board column's order with `status`. */
function ordered(q: InitialQueryBuilder, issues: Issues, filter: IssueFilter, status?: StatusCode, from?: SortValue) {
  const rows = filtered(q, issues, filter, status);
  const bounded = from === undefined ? rows : rows.where(({ i }) => (filter.dir === "desc" ? lte : gte)(i[ORDER[filter.sort]], from));
  return bounded.orderBy(({ i }) => (status === undefined ? i[ORDER[filter.sort]] : i.statusOrder), status === undefined ? filter.dir : "asc");
}

/** A window of the issues under the filter: a board column with `status`, else the list. */
export const listQuery = (issues: Issues, filter: IssueFilter, window: ListWindow, status?: StatusCode) => (q: InitialQueryBuilder) =>
  ordered(q, issues, filter, status, window.from).offset(window.offset).limit(window.limit);

/** A board column: the issues with `status` under the filter, in board order, for `useLiveInfiniteQuery` to page. */
export const columnQuery = (issues: Issues, filter: IssueFilter, status: StatusCode) => (q: InitialQueryBuilder) => ordered(q, issues, filter, status);

/**
 * `listQuery` as a live query of its own, for a query `useLiveQuery` cannot hash. It is dropped as soon as no one
 * subscribes: TanStack's default keeps it 5 s, loading rows and filtering every change for no one.
 */
export const windowQuery = (issues: Issues, filter: IssueFilter, window: ListWindow, status?: StatusCode) =>
  createLiveQueryCollection({ gcTime: 1, query: listQuery(issues, filter, window, status) });

/** The issue `id`, unless it is a tombstone. */
export const issueById = (issues: Issues, id: string) => (q: InitialQueryBuilder) =>
  q
    .from({ i: issues })
    .where(({ i }) => and(eq(i.id, id), eq(i.deleted, false)))
    .findOne();

/** The description of issue `id`. */
export const bodyOf = (bodies: Collection<Body, string>, id: string) => (q: InitialQueryBuilder) =>
  q
    .from({ b: bodies })
    .where(({ b }) => eq(b.id, id))
    .findOne();

/** The live comments of issue `id`, oldest first. */
export const commentsOf = (comments: Collection<Comment, string>, id: string) => (q: InitialQueryBuilder) =>
  q
    .from({ c: comments })
    .where(({ c }) => and(eq(c.issue_id, id), eq(c.deleted, false)))
    .orderBy(({ c }) => c.created, "asc");

/** The sync row, which the leader writes and every tab's status bar reads. */
export const syncRow = (sync: Collection<SyncState, string>) => (q: InitialQueryBuilder) => q.from({ s: sync }).findOne();

/** The rows with unsent edits: the outbox. */
export const unsent = <T extends Synced & { readonly id: string }>(rows: Collection<T, string>) =>
  createLiveQueryCollection((q) => q.from({ r: rows }).where(({ r }) => eq(r.pending, true)));

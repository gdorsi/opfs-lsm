import type { Scalar } from "@opfs-lsm/docstore";
import { and, createLiveQueryCollection, eq, gte, ilike, inArray, lte, type InitialQueryBuilder, type Ref } from "@tanstack/db";
import type { StatusCode, StoredIssue } from "../domain/model.ts";
import type { IssueFilter, SortField } from "./filter.ts";
import type { Store } from "./store.ts";

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
export function filtered(q: InitialQueryBuilder, issues: Store["issues"], filter: IssueFilter, status?: StatusCode) {
  const base = q.from({ i: issues }).where(({ i }) => matches(i, filter, status));
  if (filter.q === "" || isLiteralOnly(filter.q)) return base;
  const needle = filter.q.toLowerCase();
  return base.fn.where(({ i }) => i.title.toLowerCase().includes(needle));
}

/** Where the list's window starts: `offset` rows past the first issue whose sort value is `from` or sorts after it. */
export type ListStart = { readonly from?: Scalar; readonly offset: number };

/** An ordered window of `size` issues under the filter: a board column with `status`, else the list from `start`. */
export const windowQuery = (issues: Store["issues"], filter: IssueFilter, size: number, status?: StatusCode, start?: ListStart) =>
  createLiveQueryCollection((q) => {
    const rows = filtered(q, issues, filter, status);
    const from = start?.from;
    const bounded = from === undefined ? rows : rows.where(({ i }) => (filter.dir === "desc" ? lte : gte)(i[ORDER[filter.sort]], from));
    const ordered = bounded.orderBy(({ i }) => (status === undefined ? i[ORDER[filter.sort]] : i.statusOrder), status === undefined ? filter.dir : "asc");
    return (start ? ordered.offset(start.offset) : ordered).limit(size);
  });


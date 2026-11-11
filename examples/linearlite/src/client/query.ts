import { and, createLiveQueryCollection, eq, ilike, inArray, type InitialQueryBuilder, type Ref } from "@tanstack/db";
import type { Issue, StatusCode } from "../domain/model.ts";
import type { IssueFilter } from "./filter.ts";
import type { Store } from "./store.ts";

/**
 * `ilike` has no escape character, so `%` and `_` in a query would act as wildcards. Those queries are matched by a
 * filter function instead, which TanStack cannot optimize. Every other query stays a plain `ilike`.
 */
const isLiteralOnly = (q: string) => !/[%_]/.test(q);

/** The filter as a `where`. Tombstones are always out. */
function matches(i: Ref<Issue>, filter: IssueFilter, status?: StatusCode) {
  const terms = [
    eq(i.deleted, false),
    ...(status !== undefined ? [eq(i.status, status)] : filter.status.length > 0 ? [inArray(i.status, [...filter.status])] : []),
    ...(filter.priority.length > 0 ? [inArray(i.priority, [...filter.priority])] : []),
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

export const windowQuery = (issues: Store["issues"], filter: IssueFilter, size: number, status?: StatusCode) =>
  createLiveQueryCollection((q) =>
    filtered(q, issues, filter, status)
      .orderBy(({ i }) => (status === undefined ? i[filter.sort] : i.kanbanorder), status === undefined ? filter.dir : "asc")
      .limit(size),
  );


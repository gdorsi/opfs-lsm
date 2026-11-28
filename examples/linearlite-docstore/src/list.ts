import { eq, ilike, inArray, query, type LiveQuery, type QueryRoot } from "@opfs-lsm/db";
import { SORT_FIELDS, type Filter, type Issue, type Store } from "./model.ts";

export const PAGE = 50;

type Issues = Store["issues"];

/** The issues `filter` lets through. */
function matching(q: QueryRoot, issues: Issues, filter: Filter) {
  let list = q.from({ i: issues });
  if (filter.status.length > 0) list = list.where(({ i }) => inArray(i.status, filter.status));
  if (filter.priority.length > 0) list = list.where(({ i }) => inArray(i.priority, filter.priority));
  // The search is text: a % or _ in it is itself, not a wildcard.
  if (filter.q !== "") list = list.where(({ i }) => ilike(i.title, `%${filter.q.replace(/[\\%_]/g, "\\$&")}%`));
  return list;
}

/** Page `page` of the list under `filter`: `PAGE` rows, fewer at its end. */
export function pageOf(issues: Issues, filter: Filter, page: number): LiveQuery<readonly Issue[]> {
  return query((q) => {
    let list = matching(q, issues, filter);
    for (const field of SORT_FIELDS[filter.sort]) list = list.orderBy(({ i }) => i[field], filter.dir);
    return list.offset(page * PAGE).limit(PAGE);
  });
}

/** How many issues the list under `filter` holds. */
export const totalOf = (issues: Issues, filter: Filter): LiveQuery<number> => query((q) => matching(q, issues, filter).count());

export const issueOf = (issues: Issues, id: string): LiveQuery<Issue | undefined> =>
  query((q) =>
    q
      .from({ i: issues })
      .where(({ i }) => eq(i.id, id))
      .findOne(),
  );

/** One issue, or undefined when the database holds none. */
export const anyIssue = (issues: Issues): LiveQuery<Issue | undefined> => query((q) => q.from({ i: issues }).findOne());

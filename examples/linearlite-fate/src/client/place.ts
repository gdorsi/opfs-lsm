import type { InsertionTarget } from "react-fate";
import { kanbanBetween } from "../domain/kanban.ts";
import type { FilterArgs, IssueFields } from "../domain/model.ts";
import { matches } from "./args.ts";

/**
 * The cached lists a new issue could top. fate puts a new item only into lists a mutation names; lists that are not
 * named catch up when they are next fetched.
 */
export type Shown = {
  /** The issue's board column under the board's filter, and the `kanbanorder` of its first card, null when it has none. */
  readonly column?: { readonly filter: FilterArgs; readonly target: InsertionTarget<"Issue">; readonly top: string | null };
  /** The list's first window, when its sort is newest first. */
  readonly list?: { readonly filter: FilterArgs; readonly target: InsertionTarget<"Issue"> };
};

export type NewIssuePlace = {
  /** The lists that show the new issue at once. */
  readonly into: InsertionTarget<"Issue">[];
  /** A `kanbanorder` above its column's first card; none when the column does not show the issue. */
  readonly shownOrder?: string;
  /** `shownOrder` when that card is the first of the whole column. Under a priority or text filter it may not be, and the server picks the order. */
  readonly sentOrder?: string;
};

/** A new issue tops its board column and the list when each is cached and its filter lists the issue. */
export function placeNewIssue({ column, list }: Shown, issue: Pick<IssueFields, "status" | "priority" | "title">): NewIssuePlace {
  const inColumn = column !== undefined && matches(column.filter, issue);
  const shownOrder = inColumn ? kanbanBetween(null, column.top) : undefined;
  const wholeColumn = inColumn && column.filter.priority.length === 0 && column.filter.q === "";
  return {
    into: [...(inColumn ? [column.target] : []), ...(list && matches(list.filter, issue) ? [list.target] : [])],
    ...(shownOrder !== undefined && { shownOrder }),
    ...(wholeColumn && { sentOrder: shownOrder }),
  };
}

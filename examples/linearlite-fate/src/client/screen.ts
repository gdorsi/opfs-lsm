import { useEffect } from "react";
import type { InsertionTarget } from "react-fate";
import { kanbanBetween } from "../domain/kanban.ts";
import type { FilterArgs, IssueFields, StatusCode } from "../domain/model.ts";
import { matches } from "./args.ts";

/**
 * The lists on screen, as fate returned them. fate puts a new item only into lists a mutation names, so a command
 * that creates or moves an issue or adds a comment names these. Lists elsewhere catch up when they are next fetched.
 */
export type OnScreen = {
  /** The list's window when it starts at row 0 under a newest-first sort, the one a new issue tops. */
  readonly top: Map<"list", { readonly filter: FilterArgs; readonly target: InsertionTarget<"Issue"> }>;
  /** Each board column under the board's filter, and the `kanbanorder` of its first card, null when it shows none. */
  readonly columns: Map<StatusCode, { readonly filter: FilterArgs; readonly target: InsertionTarget<"Issue">; readonly top: string | null }>;
  readonly comments: Map<string, InsertionTarget<"Comment">>;
};

export const onScreen: OnScreen = { top: new Map(), columns: new Map(), comments: new Map() };

/** Lists `value` under `key` while the calling component is mounted with it; `undefined` lists nothing. */
export function useOnScreen<K, V>(map: Map<K, V>, key: K, value: V | undefined): void {
  useEffect(() => {
    if (value === undefined) return;
    map.set(key, value);
    return () => {
      if (map.get(key) === value) map.delete(key);
    };
  }, [map, key, value]);
}

export type NewIssuePlace = {
  /** The lists that show the new issue at once. */
  readonly into: InsertionTarget<"Issue">[];
  /** A `kanbanorder` above its column's first card on screen; none when the column does not show the issue. */
  readonly shownOrder?: string;
  /** `shownOrder` when that card is the first of the whole column. Under a priority or text filter it may not be, and the server picks the order. */
  readonly sentOrder?: string;
};

/** A new issue tops its board column and the list when each is on screen and its filter lists the issue. */
export function placeNewIssue(screen: OnScreen, issue: Pick<IssueFields, "status" | "priority" | "title">): NewIssuePlace {
  const column = screen.columns.get(issue.status);
  const list = screen.top.get("list");
  const inColumn = column !== undefined && matches(column.filter, issue);
  const shownOrder = inColumn ? kanbanBetween(null, column.top) : undefined;
  const wholeColumn = inColumn && column.filter.priority.length === 0 && column.filter.q === "";
  return {
    into: [...(inColumn ? [column.target] : []), ...(list && matches(list.filter, issue) ? [list.target] : [])],
    ...(shownOrder !== undefined && { shownOrder }),
    ...(wholeColumn && { sentOrder: shownOrder }),
  };
}

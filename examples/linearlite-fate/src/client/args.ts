import type { ColumnArgs, FilterArgs, IssueFields, StatusCode, WindowArgs } from "../domain/model.ts";
import type { IssueFilter } from "./filter.ts";

/** Rows the list asks to have loaded around the first visible one. */
export const LIST_WINDOW = 100;
/** Window offsets are multiples of this, so a small scroll keeps the same window and every window is a reusable cache entry. */
const STEP = 50;

/** The window that holds rows `start` to `start + LIST_WINDOW` of the filtered list. */
export function windowArgs(filter: IssueFilter, start: number): WindowArgs {
  const { status, priority, q, sort, dir } = filter;
  return { status, priority, q, sort, dir, offset: Math.floor(Math.max(0, start) / STEP) * STEP, limit: LIST_WINDOW + STEP };
}

/** The fields a count depends on: a sort change keeps the counts. */
export const filterArgs = ({ status, priority, q }: IssueFilter): FilterArgs => ({ status, priority, q });

/** A board column under the filter; none when the filter leaves its status out. */
export function columnArgs(status: StatusCode, filter: IssueFilter, first: number): ColumnArgs | undefined {
  if (filter.status.length > 0 && !filter.status.includes(status)) return undefined;
  return { column: status, priority: filter.priority, q: filter.q, first };
}

/** Whether the server would list `issue` under `filter`; the title test is the server's case-insensitive `LIKE`. */
export function matches(filter: FilterArgs, issue: Pick<IssueFields, "status" | "priority" | "title">): boolean {
  return (
    (filter.status.length === 0 || filter.status.includes(issue.status)) &&
    (filter.priority.length === 0 || filter.priority.includes(issue.priority)) &&
    asciiLower(issue.title).includes(asciiLower(filter.q))
  );
}

const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

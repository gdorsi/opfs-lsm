import type { PriorityCode, StatusCode } from "../domain/model.ts";

export const SORT_FIELDS = ["modified", "created", "priority", "status", "title"] as const;
export type SortField = (typeof SORT_FIELDS)[number];

/** The list and board view, as the URL holds it: `?status=1,2&priority=0&q=sync&sort=modified&dir=desc`. */
export interface IssueFilter {
  /** Empty: every status. */
  readonly status: readonly StatusCode[];
  /** Empty: every priority. */
  readonly priority: readonly PriorityCode[];
  /** Title substring, case-insensitive. Empty: no title filter. */
  readonly q: string;
  readonly sort: SortField;
  readonly dir: "asc" | "desc";
}

const MAX_QUERY = 200;

/** Accepts `1,2`, `1`, `[1,2]` or `["1","2"]`: TanStack Router JSON-decodes search values that look like JSON. */
function codes(raw: unknown): (StatusCode & PriorityCode)[] {
  const parts = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : raw === undefined ? [] : [raw];
  const valid = new Set<StatusCode & PriorityCode>();
  for (const part of parts) {
    const n = typeof part === "number" ? part : typeof part === "string" && /^\s*\d\s*$/.test(part) ? Number(part) : NaN;
    if (Number.isInteger(n) && n >= 0 && n <= 4) valid.add(n as StatusCode & PriorityCode);
  }
  return [...valid].sort();
}

/** `validateSearch` for the list and board. Anything unrecognised falls back to the default instead of failing. */
export function parseIssueFilter(search: Record<string, unknown>): IssueFilter {
  const sort = SORT_FIELDS.find((f) => f === search.sort) ?? "modified";
  const q = typeof search.q === "string" ? search.q.slice(0, MAX_QUERY) : typeof search.q === "number" ? String(search.q) : "";
  return {
    status: codes(search.status),
    priority: codes(search.priority),
    q,
    sort,
    dir: search.dir === "asc" ? "asc" : "desc",
  };
}

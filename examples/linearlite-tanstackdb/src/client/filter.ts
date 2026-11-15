import type { PriorityCode, StatusCode } from "../domain/model.ts";

export const SORT_FIELDS = ["modified", "created", "priority", "status", "title"] as const;
export type SortField = (typeof SORT_FIELDS)[number];

export interface IssueFilter {
  readonly status: readonly StatusCode[];
  readonly priority: readonly PriorityCode[];
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

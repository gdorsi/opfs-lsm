import { defineSchema } from "@opfs-lsm/docstore";

export const STATUS_LABELS = ["Backlog", "Todo", "In Progress", "Done", "Canceled"] as const;
export const PRIORITY_LABELS = ["Urgent", "High", "Medium", "Low", "No priority"] as const;
export const CODES = [0, 1, 2, 3, 4] as const;
export type Code = (typeof CODES)[number];

export type Issue = {
  id: string;
  title: string;
  status: Code;
  priority: Code;
  username: string;
  created: number;
  modified: number;
};

export type Comment = { id: string; body: string; username: string; created: number };

/** What the issue page shows besides the issue. Its id is the issue's. Written the first time the issue is opened. */
export type Detail = { id: string; description: string; comments: Comment[] };

/**
 * One index per read of the list. `byModified` is also the text index of the titles: read without a `match`, it
 * lists every issue by `modified`. `byStatus` and `byPriority` hold both codes, so a filter on one or both is a
 * set of ranges, each counted from its entries.
 */
export const schema = defineSchema<{ issues: Issue; details: Detail }>()({
  version: 2,
  collections: {
    issues: {
      byModified: { by: "modified", text: "title" },
      byCreated: { by: "created" },
      byStatus: { by: ["status", "priority", "modified"] },
      byPriority: { by: ["priority", "status", "modified"] },
    },
    details: {},
  },
});

export const SORTS = ["modified", "created", "priority", "status"] as const;
export type Sort = (typeof SORTS)[number];
export const SORT_LABELS: Record<Sort, string> = { modified: "Modified", created: "Created", priority: "Priority", status: "Status" };

export type Filter = {
  readonly status: readonly Code[];
  readonly priority: readonly Code[];
  readonly q: string;
  readonly sort: Sort;
  readonly dir: "asc" | "desc";
};

export const DEFAULT_FILTER: Filter = { status: [], priority: [], q: "", sort: "modified", dir: "desc" };

/** What changed between two filters, for the page that shows the timing of the change. */
export function describe(filter: Filter, before: Filter): string {
  const parts: string[] = [];
  if (String(filter.status) !== String(before.status)) parts.push(filter.status.length ? `Status: ${filter.status.map((c) => STATUS_LABELS[c]).join(", ")}` : "Status cleared");
  if (String(filter.priority) !== String(before.priority)) parts.push(filter.priority.length ? `Priority: ${filter.priority.map((c) => PRIORITY_LABELS[c]).join(", ")}` : "Priority cleared");
  if (filter.q !== before.q) parts.push(filter.q ? `Search "${filter.q}"` : "Search cleared");
  if (filter.sort !== before.sort || filter.dir !== before.dir) parts.push(`Sorted by ${filter.sort}, ${filter.dir === "asc" ? "ascending" : "descending"}`);
  return parts.join(" · ");
}

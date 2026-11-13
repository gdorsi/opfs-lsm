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

/**
 * One index per read of the list. `byModified` is also the text index of the titles: read without a `match`, it
 * lists every issue by `modified`. `byStatus` and `byPriority` hold both codes, so a filter on one or both is a
 * set of ranges, each counted from its entries.
 */
export const schema = defineSchema<{ issues: Issue }>()({
  version: 1,
  collections: {
    issues: {
      byModified: { on: "modified", text: "title" },
      byCreated: { on: "created" },
      byStatus: { on: ["status", "priority", "modified"] },
      byPriority: { on: ["priority", "status", "modified"] },
    },
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

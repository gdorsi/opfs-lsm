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

/**
 * What the issue page shows besides the issue. Its id is the issue's. Generated and written the first time the issue
 * is opened, so it is a cache: the app removes all of them when storage runs short and makes them again on demand.
 */
export type Detail = { id: string; description: string; comments: Comment[] };

/** The description the user wrote for an issue created in the app. Its id is the issue's. Never removed for space. */
type Authored = { id: string; description: string };

/** The one row `storage`: kv asked for space and the user has not agreed to free it yet. Every tab reads it. */
type Meta = { id: string; pressure: boolean };

/**
 * One index per read of the list. `byModified` is also the text index of the titles: read without a `match`, it
 * lists every issue by `modified`. `byStatus` and `byPriority` hold both codes, so a filter on one or both is a
 * set of ranges, each counted from its entries.
 */
export const schema = defineSchema<{ issues: Issue; details: Detail; authored: Authored; meta: Meta }>()({
  version: 3,
  collections: {
    issues: {
      byModified: { on: "modified", text: "title" },
      byCreated: { on: "created" },
      byStatus: { on: ["status", "priority", "modified"] },
      byPriority: { on: ["priority", "status", "modified"] },
    },
    details: {},
    authored: {},
    meta: {},
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

import { collection, type Database } from "@opfs-lsm/db";
import * as v from "valibot";

export const STATUS_LABELS = ["Backlog", "Todo", "In Progress", "Done", "Canceled"] as const;
export const PRIORITY_LABELS = ["Urgent", "High", "Medium", "Low", "No priority"] as const;
export const CODES = [0, 1, 2, 3, 4] as const;
const Code = v.picklist(CODES);
export type Code = v.InferOutput<typeof Code>;

/** A valibot schema per collection. The database stores what a schema returns, so these objects are strict: a key they do not list is an error, not dropped. */
const Issue = v.strictObject({
  id: v.string(),
  title: v.pipe(v.string(), v.minLength(1)),
  status: Code,
  priority: Code,
  username: v.string(),
  created: v.number(),
  modified: v.number(),
});
export type Issue = v.InferOutput<typeof Issue>;

const Comment = v.strictObject({ id: v.string(), body: v.string(), username: v.string(), created: v.number() });

/** What the issue page shows besides the issue. Its id is the issue's. Written the first time the issue is opened. */
const Detail = v.strictObject({ id: v.string(), description: v.string(), comments: v.array(Comment) });
export type Detail = v.InferOutput<typeof Detail>;

export const SORTS = ["modified", "created", "priority", "status"] as const;
export type Sort = (typeof SORTS)[number];
export const SORT_LABELS: Record<Sort, string> = { modified: "Modified", created: "Created", priority: "Priority", status: "Status" };

/** The fields each sort orders by, which are the fields of the index that serves it. */
export const SORT_FIELDS = {
  modified: ["modified"],
  created: ["created"],
  status: ["status", "priority", "modified"],
  priority: ["priority", "status", "modified"],
} as const satisfies Record<Sort, readonly (keyof Issue)[]>;

/**
 * The collections and their indexes, one index per order of the list. `byModified` is also the text index of the
 * titles. `byStatus` and `byPriority` hold both codes, so a filter on one or both is a set of ranges, each counted
 * from its entries.
 */
export const schema = {
  version: 2,
  collections: {
    issues: collection(Issue)
      .text("byModified", SORT_FIELDS.modified, "title")
      .index("byCreated", SORT_FIELDS.created)
      .index("byStatus", SORT_FIELDS.status)
      .index("byPriority", SORT_FIELDS.priority),
    details: collection(Detail),
  },
};

export type Store = Database<typeof schema.collections>["collections"];

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

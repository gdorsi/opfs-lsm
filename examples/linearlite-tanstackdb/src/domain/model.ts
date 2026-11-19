import * as v from "valibot";
import type { FieldsWith, Stream } from "./stores.ts";

export const STATUSES = ["backlog", "todo", "in_progress", "done", "canceled"] as const;
export const STATUS_LABELS = ["Backlog", "Todo", "In Progress", "Done", "Canceled"] as const;
export const PRIORITY_LABELS = ["Urgent", "High", "Medium", "Low", "No priority"] as const;

const ReadonlyString = v.pipe(v.string(), v.readonly());
const ReadonlyNumber = v.pipe(v.number(), v.readonly());

/** A status or a priority: an index into `STATUS_LABELS` or `PRIORITY_LABELS`. */
const Code = v.picklist([0, 1, 2, 3, 4]);
export type StatusCode = v.InferOutput<typeof Code>;
export type PriorityCode = v.InferOutput<typeof Code>;

const Clocks = v.pipe(v.record(v.string(), v.number()), v.readonly());
export type Clocks = v.InferOutput<typeof Clocks>;

/**
 * The row types come from these schemas. The kv backend validates each write against them and stores what they
 * return, so the objects are strict: a key a schema does not list is an error, not a silent drop. A server-owned
 * field is `readonly`. A schema checks the shape only. The length limits are the server's (`parse.ts`).
 *
 * `dirty`: field -> local edit clock of an edit the server has not acknowledged, absent when clean. `pending` is
 * `true` exactly when `dirty` is present, so a sparse index lists the rows with unsent edits.
 */
const Synced = v.strictObject({
  version: ReadonlyNumber,
  dirty: v.pipe(v.optional(Clocks), v.readonly()),
  pending: v.pipe(v.optional(v.literal(true)), v.readonly()),
});
export type Synced = v.InferOutput<typeof Synced>;

const Issue = v.strictObject({
  id: ReadonlyString,
  title: v.string(),
  status: Code,
  priority: Code,
  kanbanorder: v.string(),
  username: ReadonlyString,
  created: ReadonlyNumber,
  modified: v.number(),
  deleted: v.boolean(),
  ...Synced.entries,
});
export type Issue = v.InferOutput<typeof Issue>;

/** An issue as stored: its fields, and the keys the priority and status sorts order by. */
export const StoredIssue = v.strictObject({ ...Issue.entries, priorityOrder: ReadonlyNumber, statusOrder: ReadonlyString });
export type StoredIssue = v.InferOutput<typeof StoredIssue>;

/** Priority, then status, then `modified` (ms, below 1e13): one value per issue, so a sort on it has few ties. */
export const priorityOrder = (priority: number, status: number, modified: number) => priority * 1e14 + status * 1e13 + modified;

export const stored = (issue: Issue): StoredIssue => ({
  ...issue,
  priorityOrder: priorityOrder(issue.priority, issue.status, issue.modified),
  statusOrder: `${issue.status}${issue.kanbanorder}`,
});
export const Body = v.strictObject({ id: ReadonlyString, description: v.string(), ...Synced.entries });
export type Body = v.InferOutput<typeof Body>;

export const Comment = v.strictObject({
  key: ReadonlyString,
  id: ReadonlyString,
  issue_id: ReadonlyString,
  body: v.string(),
  username: ReadonlyString,
  created: ReadonlyNumber,
  deleted: v.boolean(),
  ...Synced.entries,
});
export type Comment = v.InferOutput<typeof Comment>;

export const SyncState = v.strictObject({
  id: v.pipe(v.literal("sync"), v.readonly()),
  /** The store's `FORMAT` when the rows were written. */
  format: v.number(),
  epoch: v.nullable(v.string()),
  cursors: v.strictObject({ issues: v.number(), bodies: v.number(), comments: v.number() }),
  head: v.number(),
  online: v.boolean(),
  caughtUp: v.strictObject({ issues: v.boolean(), bodies: v.boolean(), comments: v.boolean() }),
  /**
   * Clearing the cached bodies and comments when kv wants space: `asked` until a user agrees in any tab, then
   * `confirmed` until the leader has cleared them. Any tab may move it from `asked` to `confirmed`; only the leader
   * writes the rest of the row.
   */
  evict: v.picklist(["idle", "asked", "confirmed"]),
});
export type SyncState = v.InferOutput<typeof SyncState>;

export interface Rows {
  issues: Issue;
  bodies: Body;
  comments: Comment;
}
export type Clean<R> = Omit<R, "dirty" | "pending">;
export type ServerRow<S extends Stream = Stream> = S extends Stream ? Clean<Rows[S]> : never;

export const commentKey = (issueId: string, id: string) => `${issueId}/${id}`;

type PatchOf<S extends Stream> = Partial<Pick<Rows[S], Extract<FieldsWith<S, "mutable">, keyof Rows[S]>>>;
export type IssuePatch = PatchOf<"issues">;
export type BodyPatch = PatchOf<"bodies">;
export type CommentPatch = PatchOf<"comments">;
export type Patch<T extends Synced> = T extends Issue ? IssuePatch : T extends Body ? BodyPatch : T extends Comment ? CommentPatch : never;

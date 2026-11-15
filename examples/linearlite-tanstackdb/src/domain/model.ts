import type { FieldsWith, Stream } from "./stores.ts";

export const STATUSES = ["backlog", "todo", "in_progress", "done", "canceled"] as const;
export const PRIORITIES = ["urgent", "high", "medium", "low", "none"] as const;
export const STATUS_LABELS = ["Backlog", "Todo", "In Progress", "Done", "Canceled"] as const;
export const PRIORITY_LABELS = ["Urgent", "High", "Medium", "Low", "No priority"] as const;

export type StatusCode = 0 | 1 | 2 | 3 | 4;
export type PriorityCode = 0 | 1 | 2 | 3 | 4;

export type Clocks = Readonly<Record<string, number>>;
/**
 * `dirty`: field -> local edit clock of an edit the server has not acknowledged, absent when clean. `pending` is
 * `true` exactly when `dirty` is present, so a sparse index lists the rows with unsent edits.
 */
export type Synced = {
  readonly version: number;
  readonly dirty?: Clocks;
  readonly pending?: true;
};

export type Issue = Synced & {
  readonly id: string;
  title: string;
  status: StatusCode;
  priority: PriorityCode;
  kanbanorder: string;
  readonly username: string;
  readonly created: number;
  modified: number;
  deleted: boolean;
};
/** An issue as stored: its fields, and the keys the priority and status sorts order by. */
export type StoredIssue = Issue & { readonly priorityOrder: number; readonly statusOrder: string };
export type Body = Synced & {
  readonly id: string;
  description: string;
};
export type Comment = Synced & {
  readonly key: string;
  readonly id: string;
  readonly issue_id: string;
  body: string;
  readonly username: string;
  readonly created: number;
  deleted: boolean;
};

export type SyncState = {
  readonly id: "sync";
  /** The store's `FORMAT` when the rows were written. */
  format: number;
  epoch: string | null;
  cursors: Record<Stream, number>;
  head: number;
  online: boolean;
  caughtUp: Record<Stream, boolean>;
  /** Set while kv wants space and the user has not yet confirmed clearing the cached bodies and comments. */
  pressure?: boolean;
};

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

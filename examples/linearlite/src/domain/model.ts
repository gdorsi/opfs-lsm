export const STATUSES = ["backlog", "todo", "in_progress", "done", "canceled"] as const;
export const PRIORITIES = ["urgent", "high", "medium", "low", "none"] as const;
export const STATUS_LABELS = ["Backlog", "Todo", "In Progress", "Done", "Canceled"] as const;
export const PRIORITY_LABELS = ["Urgent", "High", "Medium", "Low", "No priority"] as const;
export const STREAMS = ["issues", "bodies", "comments"] as const;

export type StatusCode = 0 | 1 | 2 | 3 | 4;
export type PriorityCode = 0 | 1 | 2 | 3 | 4;
export type Stream = (typeof STREAMS)[number];

export type Clocks = Readonly<Record<string, number>>;
export type Synced = {
  readonly version: number;
  readonly dirty?: Clocks;
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
  epoch: string | null;
  cursors: Record<Stream, number>;
  head: number;
  online: boolean;
  caughtUp: Record<Stream, boolean>;
};

export interface Rows {
  issues: Issue;
  bodies: Body;
  comments: Comment;
}
export type ServerRow<S extends Stream = Stream> = S extends Stream ? Omit<Rows[S], "dirty"> : never;

export const commentKey = (issueId: string, id: string) => `${issueId}/${id}`;

export const MUTABLE_FIELDS = {
  issues: ["title", "status", "priority", "kanbanorder", "deleted"],
  bodies: ["description"],
  comments: ["body", "deleted"],
} as const satisfies Record<Stream, readonly string[]>;

export type IssuePatch = Partial<Pick<Issue, "title" | "status" | "priority" | "kanbanorder" | "deleted">>;
export type BodyPatch = Partial<Pick<Body, "description">>;
export type CommentPatch = Partial<Pick<Comment, "body" | "deleted">>;
export type Patch<T extends Synced> = T extends Issue ? IssuePatch : T extends Body ? BodyPatch : T extends Comment ? CommentPatch : never;

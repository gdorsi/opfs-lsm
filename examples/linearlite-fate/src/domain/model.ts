import type { SortField } from "../client/filter.ts";

export const STATUSES = ["backlog", "todo", "in_progress", "done", "canceled"] as const;
export const PRIORITIES = ["urgent", "high", "medium", "low", "none"] as const;
export const STATUS_LABELS = ["Backlog", "Todo", "In Progress", "Done", "Canceled"] as const;
export const PRIORITY_LABELS = ["Urgent", "High", "Medium", "Low", "No priority"] as const;

/**
 * fate's persistence key on the client and the scope of its mutation receipts on the server: they must match. One per
 * user, so two users in one browser keep separate caches and queues.
 */
export const persistenceKey = (user: string): string => `linearlite:user:${user}`;

/** The user a `?user=` value or `x-linearlite-user` header names, else `anonymous`. */
export const userName = (raw: string | null): string => (raw !== null && /^[A-Za-z0-9._-]{1,32}$/.test(raw) ? raw : "anonymous");

/** Every status code, and every priority code: both run 0 to 4. */
export const CODES = [0, 1, 2, 3, 4] as const;
export type StatusCode = (typeof CODES)[number];
export type PriorityCode = (typeof CODES)[number];

/** An issue's row: what the server's `issue` table holds besides the description, and what lists show. */
export type IssueFields = {
  readonly id: string;
  readonly title: string;
  readonly status: StatusCode;
  readonly priority: PriorityCode;
  readonly kanbanorder: string;
  readonly username: string;
  readonly created: number;
  readonly modified: number;
};

/** fate's cache entities, shared by the server's data views and the client's views. */
export type IssueEntity = IssueFields & {
  readonly __typename: "Issue";
  readonly description: string;
  readonly comments: CommentEntity[];
};
export type CommentEntity = {
  readonly __typename: "Comment";
  readonly id: string;
  readonly body: string;
  readonly username: string;
  readonly created: number;
};

/** Mutation inputs. Ids are made on the client, so a create and later edits of it can queue offline together. */
export type IssuePatch = Partial<Pick<IssueFields, "title" | "status" | "priority" | "kanbanorder"> & { readonly description: string }>;
/** Without `kanbanorder` the server puts the issue at the top of its column. */
export type NewIssue = Pick<IssueFields, "id" | "title" | "status" | "priority"> & { readonly description: string; readonly kanbanorder?: string };
export type NewComment = { readonly id: string; readonly issueId: string; readonly body: string };

/**
 * Request args, as the server receives them. Each distinct args object is its own entry in fate's cache, and fate
 * reads `first`, `last`, `after` and `before` as its own paging, so a window says `offset` and `limit`.
 */
export type FilterArgs = { readonly status: readonly StatusCode[]; readonly priority: readonly PriorityCode[]; readonly q: string };
export type WindowArgs = FilterArgs & { readonly sort: SortField; readonly dir: "asc" | "desc"; readonly offset: number; readonly limit: number };
/** One board column, by `kanbanorder`, paged forward by fate with `first` and `after`. */
export type ColumnArgs = { readonly column: StatusCode; readonly priority: readonly PriorityCode[]; readonly q: string; readonly first: number };
export type StatusCounts = readonly [number, number, number, number, number];
export const totalOf = (counts: StatusCounts): number => counts.reduce((a, b) => a + b, 0);


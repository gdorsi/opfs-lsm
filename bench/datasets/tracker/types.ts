/**
 * The task-tracker dataset's contract: the entity rows, the history's
 * events, and the goal spec. This is the one dataset file a contender may
 * import: the history and the oracle stay out of contender code.
 *
 * Every sort key ends in a field the generator keeps unique (`updatedAt`,
 * `createdAt`: one simulated clock that ticks at least 1 ms per action;
 * `number` within a project), so no order needs an id tie-break.
 */

export const STATUSES = ["backlog", "todo", "in_progress", "in_review", "done", "canceled"] as const;
export type Status = (typeof STATUSES)[number];
/** "Open" in every goal below. No stored field holds it: a contender expresses it with its library's IN-list or one range per status. */
export const OPEN = ["backlog", "todo", "in_progress", "in_review"] as const satisfies readonly Status[];
export type Priority = 0 | 1 | 2 | 3 | 4;

// ---------------------------------------------------------------- entities: the only rows a store holds

export type User = { readonly id: string; readonly name: string; readonly email: string };
export type Project = { readonly id: string; readonly key: string; readonly name: string };
export type Label = { readonly id: string; readonly name: string; readonly color: string };
export type Issue = {
  /** Random hex: key order is uncorrelated with time, project and status, as with client-generated ids. */
  readonly id: string;
  readonly projectId: string;
  /** Per project, from 1, never reused. `${project.key}-${number}` is the issue's key. */
  readonly number: number;
  readonly title: string;
  readonly description: string;
  readonly status: Status;
  readonly priority: Priority;
  readonly assigneeId: string | null;
  readonly creatorId: string;
  /** Sorted ascending, 0 to 3 ids. */
  readonly labelIds: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
};
export type Comment = { readonly id: string; readonly issueId: string; readonly authorId: string; readonly body: string; readonly createdAt: number };

export type Entities = { users: User; projects: Project; labels: Label; issues: Issue; comments: Comment };
export type EntityName = keyof Entities;

// ---------------------------------------------------------------- history

/** Fields a patch may set. A patch of an issue always sets `updatedAt`; a new comment patches only that. */
export type IssuePatch = Partial<Pick<Issue, "title" | "status" | "priority" | "assigneeId" | "labelIds" | "updatedAt">>;

/**
 * One event touches one row. A patch carries the change, not the row: the
 * replica reads the stored row and folds the change in. Deleting an issue
 * deletes its comments with explicit events earlier in the same transaction.
 */
export type Event =
  | { [E in EntityName]: { readonly op: "create"; readonly entity: E; readonly row: Entities[E] } }[EntityName]
  | { readonly op: "patch"; readonly entity: "issues"; readonly id: string; readonly set: IssuePatch }
  | { readonly op: "patch"; readonly entity: "users"; readonly id: string; readonly set: Partial<Pick<User, "name">> }
  | { readonly op: "patch"; readonly entity: "labels"; readonly id: string; readonly set: Partial<Pick<Label, "name">> }
  | { readonly op: "delete"; readonly entity: "issues" | "comments"; readonly id: string };

/**
 * import: the first sync, rows of one entity in batches of 1,000, oldest change first.
 * sync:   remote changes, 50 events per batch.
 * bulk:   one action over many rows (a sprint closes).
 * edit:   one local action, awaited alone.
 */
export type TxKind = "import" | "sync" | "bulk" | "edit";
export type Tx = { readonly kind: TxKind; readonly events: readonly Event[] };

// ---------------------------------------------------------------- answers

export const LIMITS = { page: 50, search: 20, load: 10 } as const;

/** An issue as a list row shows it. `assignee` and `labels` are names, so every card is a join. */
export type IssueCard = {
  readonly id: string;
  /** `${project.key}-${number}` */
  readonly key: string;
  readonly title: string;
  readonly status: Status;
  readonly priority: Priority;
  readonly updatedAt: number;
  /** The assignee's name; null when unassigned. */
  readonly assignee: string | null;
  /** Label names, sorted ascending. */
  readonly labels: readonly string[];
};
export type IssueRef = { readonly id: string; readonly key: string; readonly title: string };
export type ThreadComment = { readonly id: string; readonly author: string; readonly body: string; readonly createdAt: number };
export type Thread = {
  readonly issue: IssueCard & { readonly description: string };
  /** createdAt ascending. */
  readonly comments: readonly ThreadComment[];
};
export type TriageRow = IssueRef & { readonly status: Status; readonly priority: Priority; readonly comments: number };
export type Load = { readonly name: string; readonly open: number };

/**
 * The goals. Each doc comment is the answer spec, and the oracle implements
 * it literally. Rules for every contender:
 *   1. Store the entity rows as the history gives them, plus any index the
 *      library declares natively. No app-maintained derived state: no
 *      counters, copied names or cached answers.
 *   2. A goal uses the library's own query API, the way its docs recommend.
 *   3. A goal sees every write acked before it started.
 */
export type TrackerSpec = {
  /** How many issues of `projectId` have each status, in STATUSES order. */
  statusCounts: { params: { projectId: string }; answer: number[] };
  /** The first LIMITS.page issues of `projectId` with `status`, updatedAt descending, as cards. */
  statusPage: { params: { projectId: string; status: Status }; answer: IssueCard[] };
  /** statusPage's spec, on the list a bulk edit just emptied (the sprint that closed). */
  drainedPage: { params: { projectId: string; status: Status }; answer: IssueCard[] };
  /** Issues of `projectId` by number descending, positions [offset, offset + LIMITS.page), as refs. */
  deepWindow: { params: { projectId: string; offset: number }; answer: IssueRef[] };
  /** The issue `${projectKey}-${number}` as a card with its description, and its comments with author names; null if there is none. */
  issueThread: { params: { projectKey: string; number: number }; answer: Thread | null };
  /** The first LIMITS.page open issues of `projectId` by priority ascending then createdAt ascending, each with its comment count. */
  triagePage: { params: { projectId: string }; answer: TriageRow[] };
  /** The first LIMITS.page open issues of `projectId` that carry `labelId`, updatedAt descending, as cards. */
  labelPage: { params: { projectId: string; labelId: string }; answer: IssueCard[] };
  /** The first LIMITS.page open issues assigned to `userId`, any project, updatedAt descending, as cards. */
  myIssues: { params: { userId: string }; answer: IssueCard[] };
  /** The LIMITS.page most recently updated issues of the workspace, any status, as cards. */
  recentActivity: { params: Record<string, never>; answer: IssueCard[] };
  /** Open issues of `projectId` per assignee (unassigned left out): the top LIMITS.load by count descending, then name ascending. */
  assigneeLoad: { params: { projectId: string }; answer: Load[] };
  /** The first LIMITS.search issues of `projectId` whose title contains `text` (one lowercase word, 4+ letters), updatedAt descending, as refs. */
  search: { params: { projectId: string; text: string }; answer: IssueRef[] };
};

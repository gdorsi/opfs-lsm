/**
 * The tracker's oracle: the history folded into plain Maps, and each goal
 * answered by brute force (filter, sort, slice) exactly as its spec in
 * types.ts reads. No indexes, no maintained groupings, and no code shared
 * with a contender.
 */
import type { Oracle, OracleGoals } from "../../core/goals.ts";
import { OPEN, STATUSES, LIMITS, type Comment, type Issue, type IssueCard, type IssueRef, type Label, type Project, type Status, type TrackerSpec, type Tx, type User } from "./types.ts";

const isOpen = (s: Status) => (OPEN as readonly Status[]).includes(s);
const byUpdatedDesc = (a: Issue, b: Issue) => b.updatedAt - a.updatedAt;

export class TrackerOracle implements Oracle<TrackerSpec, Tx> {
  readonly users = new Map<string, User>();
  readonly projects = new Map<string, Project>();
  readonly labels = new Map<string, Label>();
  readonly issues = new Map<string, Issue>();
  readonly comments = new Map<string, Comment>();
  /** The project whose in-progress issues the last `bulk` batch moved. */
  drained: string | undefined;

  apply(tx: Tx): void {
    for (const e of tx.events) {
      const rows = this[e.entity] as Map<string, unknown>;
      if (e.op === "create") rows.set(e.row.id, e.row);
      else if (e.op === "delete") rows.delete(e.id);
      else {
        const row = rows.get(e.id);
        if (!row) throw new Error(`history patches a missing ${e.entity} ${e.id}`);
        rows.set(e.id, { ...row, ...e.set });
      }
    }
    if (tx.kind === "bulk" && tx.events[0]?.op === "patch") this.drained = this.issues.get(tx.events[0].id)?.projectId;
  }

  liveBytes(): number {
    let n = 0;
    for (const rows of [this.users, this.projects, this.labels, this.issues, this.comments] as Map<string, object>[]) {
      for (const row of rows.values()) n += JSON.stringify(row).length;
    }
    return n;
  }

  issuesOf(projectId: string): Issue[] {
    return [...this.issues.values()].filter((i) => i.projectId === projectId);
  }

  commentCounts(): Map<string, number> {
    const n = new Map<string, number>();
    for (const c of this.comments.values()) n.set(c.issueId, (n.get(c.issueId) ?? 0) + 1);
    return n;
  }

  private key(issue: Issue): string {
    return `${this.projects.get(issue.projectId)!.key}-${issue.number}`;
  }

  private card(issue: Issue): IssueCard {
    return {
      id: issue.id,
      key: this.key(issue),
      title: issue.title,
      status: issue.status,
      priority: issue.priority,
      updatedAt: issue.updatedAt,
      assignee: issue.assigneeId === null ? null : this.users.get(issue.assigneeId)!.name,
      labels: issue.labelIds.map((id) => this.labels.get(id)!.name).sort(),
    };
  }

  private ref(issue: Issue): IssueRef {
    return { id: issue.id, key: this.key(issue), title: issue.title };
  }

  private statusPage = ({ projectId, status }: { projectId: string; status: Status }): IssueCard[] =>
    this.issuesOf(projectId)
      .filter((i) => i.status === status)
      .sort(byUpdatedDesc)
      .slice(0, LIMITS.page)
      .map((i) => this.card(i));

  readonly goals: OracleGoals<TrackerSpec> = {
    statusCounts: ({ projectId }) => {
      const issues = this.issuesOf(projectId);
      return STATUSES.map((s) => issues.filter((i) => i.status === s).length);
    },
    statusPage: this.statusPage,
    drainedPage: this.statusPage,
    deepWindow: ({ projectId, offset }) =>
      this.issuesOf(projectId)
        .sort((a, b) => b.number - a.number)
        .slice(offset, offset + LIMITS.page)
        .map((i) => this.ref(i)),
    issueThread: ({ projectKey, number }) => {
      const project = [...this.projects.values()].find((p) => p.key === projectKey);
      const issue = project && [...this.issues.values()].find((i) => i.projectId === project.id && i.number === number);
      if (!issue) return null;
      const comments = [...this.comments.values()]
        .filter((c) => c.issueId === issue.id)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((c) => ({ id: c.id, author: this.users.get(c.authorId)!.name, body: c.body, createdAt: c.createdAt }));
      return { issue: { ...this.card(issue), description: issue.description }, comments };
    },
    triagePage: ({ projectId }) => {
      const counts = this.commentCounts();
      return this.issuesOf(projectId)
        .filter((i) => isOpen(i.status))
        .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt)
        .slice(0, LIMITS.page)
        .map((i) => ({ ...this.ref(i), status: i.status, priority: i.priority, comments: counts.get(i.id) ?? 0 }));
    },
    labelPage: ({ projectId, labelId }) =>
      this.issuesOf(projectId)
        .filter((i) => isOpen(i.status) && i.labelIds.includes(labelId))
        .sort(byUpdatedDesc)
        .slice(0, LIMITS.page)
        .map((i) => this.card(i)),
    myIssues: ({ userId }) =>
      [...this.issues.values()]
        .filter((i) => i.assigneeId === userId && isOpen(i.status))
        .sort(byUpdatedDesc)
        .slice(0, LIMITS.page)
        .map((i) => this.card(i)),
    recentActivity: () =>
      [...this.issues.values()]
        .sort(byUpdatedDesc)
        .slice(0, LIMITS.page)
        .map((i) => this.card(i)),
    assigneeLoad: ({ projectId }) => {
      const open = new Map<string, number>();
      for (const i of this.issuesOf(projectId)) {
        if (i.assigneeId !== null && isOpen(i.status)) open.set(i.assigneeId, (open.get(i.assigneeId) ?? 0) + 1);
      }
      return [...open]
        .map(([id, n]) => ({ name: this.users.get(id)!.name, open: n }))
        .sort((a, b) => b.open - a.open || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .slice(0, LIMITS.load);
    },
    search: ({ projectId, text }) =>
      this.issuesOf(projectId)
        .filter((i) => i.title.includes(text))
        .sort(byUpdatedDesc)
        .slice(0, LIMITS.search)
        .map((i) => this.ref(i)),
  };
}

/**
 * The seeded history of a task-tracker workspace. A simulation runs one
 * action at a time (create an issue, comment, move it along the workflow,
 * reassign, relabel, reprioritize, retitle, delete) on a clock that ticks at
 * least 1 ms per action. Projects, people and labels are zipfian; actions
 * pick issues skewed toward the recently created, so most churn is recent
 * and a long tail reaches old issues.
 *
 * - `load`: once 70% of the issues exist, that state goes out as `import`
 *   batches (oldest change first, as a sync cursor pages), then the rest of
 *   the simulation goes out as `sync` batches of 50 events. The store is
 *   aged: issues from the import move between index ranges many times.
 * - `recent()`: one `bulk` batch closes the sprint of the project with the
 *   most issues in progress, then single `edit`s, with one user and one
 *   label renamed along the way so joined names change.
 *
 * Deterministic in (size, seed). Shares no code with the oracle or any contender.
 */
import type { SizeName } from "../../core/types.ts";
import type { History } from "../../core/goals.ts";
import { rng, seedOf, zipfian } from "../../page/model.ts";
import type { Comment, EntityName, Event, Issue, IssuePatch, Label, Priority, Project, Status, Tx, User } from "./types.ts";

type Size = { readonly users: number; readonly projects: number; readonly labels: number; readonly issues: number; readonly recentEdits: number };

export const WORKSPACES: Readonly<Record<SizeName, Size>> = {
  tiny: { users: 12, projects: 4, labels: 10, issues: 1_000, recentEdits: 50 },
  small: { users: 120, projects: 24, labels: 30, issues: 20_000, recentEdits: 300 },
  large: { users: 600, projects: 120, labels: 60, issues: 200_000, recentEdits: 300 },
};

const IMPORT_SHARE = 0.7;
const IMPORT_ROWS = 1_000;
const SYNC_EVENTS = 50;
const T0 = Date.UTC(2025, 0, 6, 9);
/** Mean gap between actions: a busy workspace. */
const GAP_MS = 45_000;

/** Action weights. Creates are a fifth of the actions, so a run takes about 5 actions per issue. */
const ACTIONS = [
  ["create", 0.2],
  ["comment", 0.45],
  ["status", 0.17],
  ["reassign", 0.05],
  ["relabel", 0.05],
  ["priority", 0.04],
  ["retitle", 0.02],
  ["deleteIssue", 0.005],
  ["deleteComment", 0.015],
] as const;
type Action = (typeof ACTIONS)[number][0];

const NEXT: Partial<Record<Status, Status>> = { backlog: "todo", todo: "in_progress", in_progress: "in_review", in_review: "done" };

export function trackerHistory(size: SizeName, seed: number): History<Tx> {
  const sim = new Workspace(WORKSPACES[size], seed);
  let loaded = false;
  return {
    load: (function* () {
      yield* sim.load();
      loaded = true;
    })(),
    recent() {
      if (!loaded) throw new Error("recent() before load was exhausted");
      return sim.recent();
    },
  };
}

class Workspace {
  private readonly r: () => number;
  private readonly pickUser: () => number;
  private readonly pickProject: () => number;
  private readonly pickLabel: () => number;
  private readonly ids = new Set<string>();
  private t = T0;

  private readonly users: User[] = [];
  private readonly projects: Project[] = [];
  private readonly nextNumber: number[] = [];
  private readonly labels: Label[] = [];
  private readonly issues = new Map<string, Issue>();
  /** Issue ids in creation order; deleted ones stay and are skipped (lazy deletion keeps picks O(1)). */
  private readonly issueOrder: string[] = [];
  private readonly comments = new Map<string, Comment>();
  private readonly commentOrder: string[] = [];
  private readonly commentsOf = new Map<string, Set<string>>();
  private created = 0;
  private readonly size: Size;

  constructor(size: Size, seed: number) {
    this.size = size;
    this.r = rng(seedOf("tracker", seed));
    this.pickUser = zipfian(size.users, this.r);
    this.pickProject = zipfian(size.projects, this.r);
    this.pickLabel = zipfian(size.labels, this.r);
    for (let i = 0; i < size.users; i++) {
      const first = FIRST[i % FIRST.length]!;
      const last = LAST[Math.floor(i / FIRST.length) % LAST.length]!;
      this.users.push({ id: this.id(), name: `${first} ${last}`, email: `${first}.${last}.${i}@example.com`.toLowerCase() });
    }
    for (let i = 0; i < size.projects; i++) {
      this.projects.push({ id: this.id(), key: `P${i + 1}`, name: `${cap(WORDS[(i * 7) % WORDS.length]!)} ${cap(WORDS[(i * 13 + 5) % WORDS.length]!)}` });
      this.nextNumber.push(1);
    }
    for (let i = 0; i < size.labels; i++) this.labels.push({ id: this.id(), name: LABELS[i % LABELS.length]! + (i >= LABELS.length ? `-${i}` : ""), color: COLORS[i % COLORS.length]! });
  }

  *load(): Generator<Tx> {
    while (this.created < this.size.issues * IMPORT_SHARE) this.act();
    yield* this.importBatches();
    let events: Event[] = [];
    while (this.created < this.size.issues) {
      events.push(...this.act());
      if (events.length >= SYNC_EVENTS) {
        yield { kind: "sync", events };
        events = [];
      }
    }
    if (events.length > 0) yield { kind: "sync", events };
  }

  *recent(): Generator<Tx> {
    yield this.closeSprint();
    const n = this.size.recentEdits;
    for (let i = 0; i < n; i++) {
      if (i === Math.floor(n / 3)) yield { kind: "edit", events: [this.renameUser()] };
      if (i === Math.floor((2 * n) / 3)) yield { kind: "edit", events: [this.renameLabel()] };
      yield { kind: "edit", events: this.act() };
    }
  }

  // ---------------------------------------------------------------- import

  private *importBatches(): Generator<Tx> {
    yield* batches("users", this.users);
    yield* batches("projects", this.projects);
    yield* batches("labels", this.labels);
    yield* batches("issues", [...this.issues.values()].sort((a, b) => a.updatedAt - b.updatedAt));
    yield* batches("comments", [...this.comments.values()].sort((a, b) => a.createdAt - b.createdAt));
  }

  // ---------------------------------------------------------------- recent

  private closeSprint(): Tx {
    const inProgress = new Map<string, Issue[]>();
    for (const issue of this.issues.values()) {
      if (issue.status !== "in_progress") continue;
      const list = inProgress.get(issue.projectId) ?? [];
      list.push(issue);
      inProgress.set(issue.projectId, list);
    }
    let sprint: Issue[] = [];
    for (const project of this.projects) {
      const list = inProgress.get(project.id) ?? [];
      if (list.length > sprint.length) sprint = list;
    }
    sprint.sort((a, b) => a.updatedAt - b.updatedAt);
    return {
      kind: "bulk",
      events: sprint.map((issue) => {
        this.tick();
        return this.patch(issue, { status: "done" });
      }),
    };
  }

  private renameUser(): Event {
    const user = this.users[this.pickUser()]!;
    const next = { ...user, name: `${user.name} II` };
    this.users[this.users.indexOf(user)] = next;
    return { op: "patch", entity: "users", id: user.id, set: { name: next.name } };
  }

  private renameLabel(): Event {
    const label = this.labels[this.pickLabel()]!;
    const next = { ...label, name: `${label.name}-v2` };
    this.labels[this.labels.indexOf(label)] = next;
    return { op: "patch", entity: "labels", id: label.id, set: { name: next.name } };
  }

  // ---------------------------------------------------------------- actions

  /** One user action: its events, in order. */
  private act(): Event[] {
    this.tick();
    const action = this.issues.size === 0 ? "create" : this.draw();
    switch (action) {
      case "create":
        return [this.createIssue()];
      case "comment":
        return this.comment();
      case "status": {
        const issue = this.pickIssue();
        const next = this.r() < 0.08 ? "canceled" : NEXT[issue.status];
        if (!next) return [this.patch(issue, { priority: this.otherPriority(issue.priority) })];
        return [this.patch(issue, { status: next })];
      }
      case "reassign": {
        const issue = this.pickIssue();
        const user = this.r() < 0.1 ? null : this.users[this.pickUser()]!.id;
        return [this.patch(issue, { assigneeId: user === issue.assigneeId ? null : user })];
      }
      case "relabel": {
        const issue = this.pickIssue();
        const labels = new Set(issue.labelIds);
        if (labels.size > 0 && (labels.size >= 3 || this.r() < 0.4)) labels.delete([...labels][Math.floor(this.r() * labels.size)]!);
        else labels.add(this.labels[this.pickLabel()]!.id);
        return [this.patch(issue, { labelIds: [...labels].sort() })];
      }
      case "priority": {
        const issue = this.pickIssue();
        return [this.patch(issue, { priority: this.otherPriority(issue.priority) })];
      }
      case "retitle":
        return [this.patch(this.pickIssue(), { title: this.words(4, 9) })];
      case "deleteIssue":
        return this.deleteIssue(this.pickIssue());
      case "deleteComment": {
        const id = this.pickComment();
        if (!id) return this.comment();
        this.dropComment(id);
        return [{ op: "delete", entity: "comments", id }];
      }
    }
  }

  private createIssue(): Event {
    const p = this.pickProject();
    const project = this.projects[p]!;
    const labels = new Set<string>();
    const nLabels = Math.floor(this.r() * 4);
    for (let i = 0; i < nLabels; i++) labels.add(this.labels[this.pickLabel()]!.id);
    const issue: Issue = {
      id: this.id(),
      projectId: project.id,
      number: this.nextNumber[p]!++,
      title: this.words(4, 9),
      description: this.words(10, 40),
      status: this.r() < 0.55 ? "backlog" : "todo",
      priority: this.priority(),
      assigneeId: this.r() < 0.75 ? this.users[this.pickUser()]!.id : null,
      creatorId: this.users[this.pickUser()]!.id,
      labelIds: [...labels].sort(),
      createdAt: this.t,
      updatedAt: this.t,
    };
    this.issues.set(issue.id, issue);
    this.issueOrder.push(issue.id);
    this.created++;
    return { op: "create", entity: "issues", row: issue };
  }

  private comment(): Event[] {
    const issue = this.pickIssue();
    const comment: Comment = { id: this.id(), issueId: issue.id, authorId: this.users[this.pickUser()]!.id, body: this.words(5, 30), createdAt: this.t };
    this.comments.set(comment.id, comment);
    this.commentOrder.push(comment.id);
    let of = this.commentsOf.get(issue.id);
    if (!of) this.commentsOf.set(issue.id, (of = new Set()));
    of.add(comment.id);
    return [{ op: "create", entity: "comments", row: comment }, this.patch(issue, {})];
  }

  private deleteIssue(issue: Issue): Event[] {
    const events: Event[] = [];
    for (const id of this.commentsOf.get(issue.id) ?? []) {
      this.comments.delete(id);
      events.push({ op: "delete", entity: "comments", id });
    }
    this.commentsOf.delete(issue.id);
    this.issues.delete(issue.id);
    events.push({ op: "delete", entity: "issues", id: issue.id });
    return events;
  }

  private dropComment(id: string): void {
    const comment = this.comments.get(id)!;
    this.comments.delete(id);
    this.commentsOf.get(comment.issueId)?.delete(id);
  }

  /** Stamps `updatedAt` with the current tick. One action patches at most one issue, so `updatedAt` stays unique. */
  private patch(issue: Issue, set: IssuePatch): Event {
    const full = { ...set, updatedAt: this.t };
    this.issues.set(issue.id, { ...issue, ...full });
    return { op: "patch", entity: "issues", id: issue.id, set: full };
  }

  // ---------------------------------------------------------------- draws

  private draw(): Action {
    let x = this.r();
    for (const [action, w] of ACTIONS) if ((x -= w) < 0) return action;
    return "comment";
  }

  /** A live issue, skewed toward the recently created: position len·(1 - u³) from the start. */
  private pickIssue(): Issue {
    for (;;) {
      const at = this.issueOrder.length - 1 - Math.floor(this.issueOrder.length * this.r() ** 3);
      const issue = this.issues.get(this.issueOrder[at]!);
      if (issue) return issue;
    }
  }

  private pickComment(): string | undefined {
    for (let tries = 0; tries < 20 && this.commentOrder.length > 0; tries++) {
      const at = this.commentOrder.length - 1 - Math.floor(this.commentOrder.length * this.r() ** 3);
      const id = this.commentOrder[at]!;
      if (this.comments.has(id)) return id;
    }
    return undefined;
  }

  private priority(): Priority {
    const x = this.r();
    return x < 0.05 ? 0 : x < 0.25 ? 1 : x < 0.6 ? 2 : x < 0.85 ? 3 : 4;
  }

  private otherPriority(p: Priority): Priority {
    return ((p + 1 + Math.floor(this.r() * 4)) % 5) as Priority;
  }

  private words(min: number, max: number): string {
    const n = min + Math.floor(this.r() * (max - min + 1));
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(WORDS[Math.floor(this.r() ** 1.5 * WORDS.length)]!);
    return out.join(" ");
  }

  private tick(): void {
    this.t += 1 + Math.floor(-Math.log(1 - this.r()) * GAP_MS);
  }

  /** 16 random hex digits, unique within the workspace. */
  private id(): string {
    for (;;) {
      const id = hex8(this.r()) + hex8(this.r());
      if (!this.ids.has(id)) {
        this.ids.add(id);
        return id;
      }
    }
  }
}

function* batches(entity: EntityName, rows: readonly (User | Project | Label | Issue | Comment)[]): Generator<Tx> {
  for (let at = 0; at < rows.length; at += IMPORT_ROWS) {
    yield { kind: "import", events: rows.slice(at, at + IMPORT_ROWS).map((row) => ({ op: "create", entity, row }) as Event) };
  }
}

const hex8 = (u: number) => Math.floor(u * 0x1_0000_0000).toString(16).padStart(8, "0");
const cap = (w: string) => w[0]!.toUpperCase() + w.slice(1);

const FIRST = ["Ada", "Alan", "Barbara", "Claude", "Donald", "Edsger", "Frances", "Grace", "Hedy", "Ivan", "John", "Ken", "Leslie", "Margaret", "Niklaus", "Radia", "Robin", "Shafi", "Tim", "Vint"];
const LAST = ["Allen", "Backus", "Cerf", "Dijkstra", "Engelbart", "Floyd", "Goldberg", "Hamilton", "Hopper", "Iverson", "Kay", "Knuth", "Lamport", "Liskov", "Milner", "Perlman", "Ritchie", "Sutherland", "Thompson", "Wirth", "Hoare", "Lovelace", "Turing", "Shannon", "Kahn", "Pike", "Steele", "Wing", "Wilkes", "Rivest"];
const LABELS = ["bug", "feature", "chore", "docs", "design", "backend", "frontend", "infra", "security", "performance", "ux", "mobile", "billing", "auth", "search", "sync", "offline", "api", "onboarding", "a11y", "i18n", "tests", "flaky", "regression", "customer", "tech-debt", "spike", "blocked", "needs-info", "good-first-issue"];
const COLORS = ["#e5484d", "#f76b15", "#ffc53d", "#30a46c", "#12a594", "#0090ff", "#6e56cf", "#d6409f"];
const WORDS = [
  "fix", "add", "update", "remove", "crash", "when", "user", "opens", "settings", "page", "button", "does", "not", "work", "after", "login",
  "sync", "fails", "offline", "mode", "slow", "loading", "issue", "list", "board", "filter", "sort", "search", "results", "empty", "state",
  "dark", "theme", "colors", "wrong", "on", "mobile", "safari", "chrome", "firefox", "export", "import", "csv", "file", "upload", "size",
  "limit", "error", "message", "unclear", "improve", "onboarding", "flow", "invite", "team", "members", "permissions", "admin", "role",
  "billing", "invoice", "payment", "retry", "webhook", "timeout", "api", "rate", "limits", "token", "refresh", "expired", "session",
  "notification", "email", "digest", "weekly", "summary", "keyboard", "shortcut", "command", "menu", "palette", "drag", "drop", "reorder",
  "column", "width", "resize", "table", "view", "calendar", "timeline", "roadmap", "milestone", "cycle", "estimate", "points", "label",
  "priority", "status", "assignee", "comment", "thread", "reply", "mention", "reaction", "emoji", "markdown", "editor", "paste", "image",
  "preview", "link", "unfurl", "embed", "attachment", "storage", "quota", "cache", "memory", "leak", "performance", "regression", "test",
  "flaky", "pipeline", "deploy", "staging", "production", "rollback", "migration", "schema", "index", "query", "database", "replica",
  "backup", "restore", "audit", "log", "security", "review", "password", "reset", "account", "delete", "archive", "restore", "history",
];

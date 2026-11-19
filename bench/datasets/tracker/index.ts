/**
 * The task-tracker dataset as the goal workload takes it: the history, the
 * oracle, and per goal the access pattern it owns (bench/core/patterns.ts)
 * and how its bindings are curated from the oracle (LDBC-style: bindings near
 * one cost quantile, so cold, first and warm calls do comparable work).
 */
import type { Dataset } from "../../core/goals.ts";
import { WORKSPACES, trackerHistory } from "./history.ts";
import { TrackerOracle } from "./oracle.ts";
import { LIMITS, OPEN, type Issue, type Status, type TrackerSpec, type Tx } from "./types.ts";

const BINDINGS = 5;
const isOpen = (s: Status) => (OPEN as readonly Status[]).includes(s);

function countBy<T>(items: Iterable<T>, key: (t: T) => string | undefined): Map<string, number> {
  const n = new Map<string, number>();
  for (const t of items) {
    const k = key(t);
    if (k !== undefined) n.set(k, (n.get(k) ?? 0) + 1);
  }
  return n;
}

export const TRACKER: Dataset<TrackerSpec, Tx, TrackerOracle> = {
  title: "tracker: a task-tracker workspace aged by its history, then 11 screens' worth of goals, cold, first and warm",
  owns: ["doc-ingest", "doc-read-during-sync", "doc-edit", "doc-reread"],
  entries: { tiny: WORKSPACES.tiny.issues, small: WORKSPACES.small.issues, large: WORKSPACES.large.issues },
  history: trackerHistory,
  txOp: (tx) => tx.kind,
  txCount: (tx) => tx.events.length,
  txBytes: (tx) => JSON.stringify(tx.events).length,
  oracle: () => new TrackerOracle(),
  goals: {
    statusCounts: {
      owns: "doc-index-count",
      curate: (o, pick) => {
        const size = countBy(o.issues.values(), (i) => i.projectId);
        return pick.near(size.keys(), { cost: (p) => size.get(p)!, key: (p) => p, n: BINDINGS, q: 0.5 }).map((projectId) => ({ projectId }));
      },
    },
    statusPage: {
      owns: "doc-scattered-page",
      curate: (o, pick) => {
        const todo = countBy(o.issues.values(), (i) => (i.status === "todo" ? i.projectId : undefined));
        return pick
          .near(todo.keys(), { cost: (p) => todo.get(p)!, key: (p) => p, n: BINDINGS, q: 0.5 })
          .map((projectId) => ({ projectId, status: "todo" as const }));
      },
    },
    drainedPage: {
      owns: "doc-drained-range",
      curate: (o) => [{ projectId: o.drained ?? [...o.projects.keys()][0]!, status: "in_progress" }],
    },
    deepWindow: {
      owns: "doc-deep-window",
      curate: (o, pick) => {
        const size = countBy(o.issues.values(), (i) => i.projectId);
        return pick
          .near(size.keys(), { cost: (p) => size.get(p)!, key: (p) => p, n: BINDINGS, q: 0.9 })
          .map((projectId) => {
            const n = size.get(projectId)!;
            return { projectId, offset: Math.max(0, Math.min(Math.floor(n * 0.9), n - LIMITS.page)) };
          });
      },
    },
    issueThread: {
      owns: "doc-key-hops",
      curate: (o, pick) => {
        const comments = o.commentCounts();
        return pick
          .near(o.issues.values(), { cost: (i) => comments.get(i.id) ?? 0, key: (i) => i.id, n: BINDINGS, q: 0.9 })
          .map((i) => ({ projectKey: o.projects.get(i.projectId)!.key, number: i.number }));
      },
    },
    triagePage: {
      owns: "doc-child-count",
      curate: (o, pick) => {
        const open = countBy(o.issues.values(), (i) => (isOpen(i.status) ? i.projectId : undefined));
        return pick.near(open.keys(), { cost: (p) => open.get(p)!, key: (p) => p, n: BINDINGS, q: 0.5 }).map((projectId) => ({ projectId }));
      },
    },
    labelPage: {
      owns: "doc-multi-entry",
      curate: (o, pick) => {
        const pairs = new Map<string, { projectId: string; labelId: string; n: number }>();
        for (const i of o.issues.values()) {
          if (!isOpen(i.status)) continue;
          for (const labelId of i.labelIds) {
            const k = `${i.projectId}:${labelId}`;
            const pair = pairs.get(k) ?? { projectId: i.projectId, labelId, n: 0 };
            pair.n++;
            pairs.set(k, pair);
          }
        }
        return pick
          .near(pairs.values(), { cost: (p) => p.n, key: (p) => `${p.projectId}:${p.labelId}`, n: BINDINGS, q: 0.5 })
          .map(({ projectId, labelId }) => ({ projectId, labelId }));
      },
    },
    myIssues: {
      owns: "doc-in-list-top-n",
      curate: (o, pick) => {
        const open = countBy(o.issues.values(), (i) => (i.assigneeId !== null && isOpen(i.status) ? i.assigneeId : undefined));
        return pick.near(open.keys(), { cost: (u) => open.get(u)!, key: (u) => u, n: BINDINGS, q: 0.5 }).map((userId) => ({ userId }));
      },
    },
    recentActivity: {
      owns: "doc-newest-end",
      curate: () => [{}],
    },
    assigneeLoad: {
      owns: "doc-group-by",
      curate: (o, pick) => {
        const open = countBy(o.issues.values(), (i) => (isOpen(i.status) ? i.projectId : undefined));
        return pick.near(open.keys(), { cost: (p) => open.get(p)!, key: (p) => p, n: BINDINGS, q: 0.5 }).map((projectId) => ({ projectId }));
      },
    },
    search: {
      owns: "doc-substring",
      curate: (o, pick) => {
        // Candidates: a word of 4+ letters from a random issue's title, in that issue's project.
        const issues = [...o.issues.values()];
        const candidates = new Map<string, { projectId: string; text: string; n: number }>();
        for (let k = 0; k < 60; k++) {
          const issue = issues[Math.floor(pick.rng() * issues.length)]!;
          const words = issue.title.split(" ").filter((w) => w.length >= 4);
          const text = words[Math.floor(pick.rng() * words.length)];
          if (!text) continue;
          const n = o.issuesOf(issue.projectId).filter((i) => i.title.includes(text)).length;
          candidates.set(`${issue.projectId}:${text}`, { projectId: issue.projectId, text, n });
        }
        return pick
          .near(candidates.values(), { cost: (c) => c.n, key: (c) => `${c.projectId}:${c.text}`, n: BINDINGS, q: 0.5 })
          .map(({ projectId, text }) => ({ projectId, text }));
      },
    },
  },
  duringLoad: { during: "sync", every: 10, read: { goal: "recentActivity", params: {} } },
  reread(o) {
    // Move the most recently updated todo issue to in progress: its list, the next list and the counts must all show it.
    let latest: Issue | undefined;
    let clock = 0;
    for (const i of o.issues.values()) {
      clock = Math.max(clock, i.updatedAt);
      if (i.status === "todo" && (!latest || i.updatedAt > latest.updatedAt)) latest = i;
    }
    if (!latest) throw new Error("no todo issue to move");
    const { projectId } = latest;
    return {
      tx: { kind: "edit", events: [{ op: "patch", entity: "issues", id: latest.id, set: { status: "in_progress", updatedAt: clock + 1_000 } }] },
      reads: [
        { goal: "statusCounts", params: { projectId } },
        { goal: "statusPage", params: { projectId, status: "todo" } },
        { goal: "statusPage", params: { projectId, status: "in_progress" } },
      ],
    };
  },
};

import { collection, defineSchema, openDocStore } from "@opfs-lsm/docstore";
import { defineContender } from "../../core/types.ts";
import { LIMITS, OPEN, STATUSES, type Comment, type Issue, type IssueCard, type IssueRef, type Label, type Project, type Status, type User } from "../../datasets/tracker/types.ts";
import { kvCommon, openKv } from "../../page/kv.ts";
import { changesOf } from "../../page/tracker.ts";

const schema = defineSchema({
  version: 1,
  collections: {
    users: collection<User>(),
    labels: collection<Label>(),
    projects: collection<Project>().unique("byKey", "key"),
    issues: collection<Issue>()
      .index("byProjectStatus", ["projectId", "status", "updatedAt"])
      .unique("byNumber", ["projectId", "number"])
      .index("byTriage", ["projectId", "status", "priority", "createdAt"])
      .index("byLabel", ["labelIds[]", "projectId", "status", "updatedAt"])
      .index("byAssignee", ["assigneeId", "status", "updatedAt"])
      .index("byProjectAssignee", ["projectId", "assigneeId", "status"])
      .index("byUpdated", "updatedAt")
      .text("byTitle", ["projectId", "updatedAt"], "title"),
    comments: collection<Comment>().index("byIssue", ["issueId", "createdAt"]),
  },
});

/**
 * A docstore write is one kv batch of at most 8 MiB, and each index entry it
 * changes counts 256 bytes. With the indexes above, one write holds 1,249
 * status patches of issues with three labels, and about 1,900 of average ones.
 */
const WRITE_EVENTS = 1_200;

const distinct = <T>(xs: Iterable<T>) => [...new Set(xs)];
const isOpen = (s: Status) => (OPEN as readonly Status[]).includes(s);

export default defineContender({
  family: "tracker",
  durability: "idb-default",
  fastPath:
    "openDocStore on openDb; a collection per entity, issues indexed 8 ways; count on index entries; a deep window = query with offset; joins = getMany of distinct foreign keys; IN = query with a list of statuses in eq; group-by = one queryEntries scan; a batch = putMany or modifyMany per collection, split into writes of 1,200 events when it has more",
  engine: true,
  async open(name) {
    const kv = await openKv(name);
    const store = await openDocStore(kv, schema);
    const users = store.collection("users");
    const projects = store.collection("projects");
    const labels = store.collection("labels");
    const issues = store.collection("issues");
    const comments = store.collection("comments");
    const collections = { users, projects, labels, issues, comments };

    async function keysOf(list: readonly Issue[]): Promise<Map<string, string>> {
      const found = await projects.getMany(distinct(list.map((i) => i.projectId)));
      return new Map(found.map((p) => [p!.id, p!.key]));
    }

    /** Issues -> cards: one getMany per joined collection, on distinct ids, in parallel. */
    async function cards(list: readonly Issue[]): Promise<IssueCard[]> {
      const [people, tags, keys] = await Promise.all([
        users.getMany(distinct(list.flatMap((i) => (i.assigneeId === null ? [] : [i.assigneeId])))),
        labels.getMany(distinct(list.flatMap((i) => i.labelIds))),
        keysOf(list),
      ]);
      const name = new Map(people.map((u) => [u!.id, u!.name]));
      const tag = new Map(tags.map((l) => [l!.id, l!.name]));
      return list.map((i) => ({
        id: i.id,
        key: `${keys.get(i.projectId)}-${i.number}`,
        title: i.title,
        status: i.status,
        priority: i.priority,
        updatedAt: i.updatedAt,
        assignee: i.assigneeId === null ? null : name.get(i.assigneeId)!,
        labels: i.labelIds.map((id) => tag.get(id)!).sort(),
      }));
    }

    async function refs(list: readonly Issue[]): Promise<IssueRef[]> {
      const keys = await keysOf(list);
      return list.map((i) => ({ id: i.id, key: `${keys.get(i.projectId)}-${i.number}`, title: i.title }));
    }

    const statusPage = async ({ projectId, status }: { projectId: string; status: Issue["status"] }) =>
      cards((await issues.query({ index: "byProjectStatus", eq: [projectId, status], reverse: true, limit: LIMITS.page })).docs);

    return {
      ...kvCommon(kv),
      async apply(tx) {
        for (let at = 0; at < tx.events.length; at += WRITE_EVENTS) {
          for (const [entity, change] of changesOf({ ...tx, events: tx.events.slice(at, at + WRITE_EVENTS) })) {
            const c = collections[entity] as unknown as {
              putMany(rows: readonly object[]): Promise<void>;
              modifyMany(ids: readonly string[], fn: (docs: readonly ({ id: string } | undefined)[]) => readonly (object | null)[]): Promise<void>;
            };
            if (change.kind === "create") await c.putMany(change.rows);
            else await c.modifyMany(change.ids, (docs) => change.fold(docs));
          }
        }
      },
      goals: {
        statusCounts: ({ projectId }) => Promise.all(STATUSES.map((s) => issues.count({ index: "byProjectStatus", eq: [projectId, s] }))),
        statusPage,
        drainedPage: statusPage,
        deepWindow: async ({ projectId, offset }) =>
          refs((await issues.query({ index: "byNumber", eq: [projectId], reverse: true, offset, limit: LIMITS.page })).docs),
        async issueThread({ projectKey, number }) {
          const project = (await projects.query({ index: "byKey", eq: [projectKey], limit: 1 })).docs[0];
          const issue = project && (await issues.query({ index: "byNumber", eq: [project.id, number], limit: 1 })).docs[0];
          if (!issue) return null;
          const [[card], thread] = await Promise.all([cards([issue]), comments.query({ index: "byIssue", eq: [issue.id] })]);
          const authors = await users.getMany(distinct(thread.docs.map((c) => c.authorId)));
          const author = new Map(authors.map((u) => [u!.id, u!.name]));
          return {
            issue: { ...card!, description: issue.description },
            comments: thread.docs.map((c) => ({ id: c.id, author: author.get(c.authorId)!, body: c.body, createdAt: c.createdAt })),
          };
        },
        async triagePage({ projectId }) {
          const { docs: page } = await issues.query({ index: "byTriage", eq: [projectId, OPEN], limit: LIMITS.page });
          const [ref, counts] = await Promise.all([refs(page), Promise.all(page.map((i) => comments.count({ index: "byIssue", eq: [i.id] })))]);
          return page.map((i, k) => ({ ...ref[k]!, status: i.status, priority: i.priority, comments: counts[k]! }));
        },
        async labelPage({ projectId, labelId }) {
          return cards((await issues.query({ index: "byLabel", eq: [labelId, projectId, OPEN], reverse: true, limit: LIMITS.page })).docs);
        },
        async myIssues({ userId }) {
          return cards((await issues.query({ index: "byAssignee", eq: [userId, OPEN], reverse: true, limit: LIMITS.page })).docs);
        },
        recentActivity: async () => cards((await issues.query({ index: "byUpdated", reverse: true, limit: LIMITS.page })).docs),
        async assigneeLoad({ projectId }) {
          const { entries } = await issues.queryEntries({ index: "byProjectAssignee", eq: [projectId] });
          const open = new Map<string, number>();
          for (const { values: [, assigneeId, status] } of entries) {
            if (assigneeId !== null && isOpen(status)) open.set(assigneeId, (open.get(assigneeId) ?? 0) + 1);
          }
          const people = await users.getMany([...open.keys()]);
          return people
            .flatMap((u) => (u ? [{ name: u.name, open: open.get(u.id)! }] : []))
            .sort((a, b) => b.open - a.open || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
            .slice(0, LIMITS.load);
        },
        search: async ({ projectId, text }) =>
          refs((await issues.query({ index: "byTitle", eq: [projectId], match: text, reverse: true, limit: LIMITS.search })).docs),
      },
    };
  },
});

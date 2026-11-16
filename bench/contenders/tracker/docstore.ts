import { defineSchema, openDocStore } from "@opfs-lsm/docstore";
import { defineContender } from "../../core/types.ts";
import { LIMITS, OPEN, STATUSES, type Comment, type Issue, type IssueCard, type IssueRef, type Label, type Project, type User } from "../../datasets/tracker/types.ts";
import { kvCommon, openKv } from "../../page/kv.ts";
import { changesOf, mergeTop } from "../../page/tracker.ts";

const schema = defineSchema<{ users: User; projects: Project; labels: Label; issues: Issue; comments: Comment }>()({
  version: 1,
  collections: {
    users: {},
    labels: {},
    projects: { byKey: { by: "key", unique: true } },
    issues: {
      byProjectStatus: { by: ["projectId", "status", "updatedAt"] },
      byNumber: { by: ["projectId", "number"], unique: true },
      byTriage: { by: ["projectId", "status", "priority", "createdAt"] },
      byLabel: { by: ["labelIds[]", "projectId", "status", "updatedAt"] },
      byAssignee: { by: ["assigneeId", "status", "updatedAt"] },
      byProjectAssignee: { by: ["projectId", "assigneeId", "status"] },
      byUpdated: { by: "updatedAt" },
      byTitle: { by: ["projectId", "updatedAt"], text: "title" },
    },
    comments: { byIssue: { by: ["issueId", "createdAt"] } },
  },
});

const byUpdatedDesc = (a: Issue, b: Issue) => b.updatedAt - a.updatedAt;
const distinct = <T>(xs: Iterable<T>) => [...new Set(xs)];

export default defineContender({
  family: "tracker",
  durability: "idb-default",
  fastPath:
    "openDocStore on openDb; a collection per entity, issues indexed 8 ways; count on index entries; joins = getMany of distinct foreign keys; IN = one query per status, merged; a batch = putMany or modifyMany per collection",
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
        for (const [entity, change] of changesOf(tx)) {
          const c = collections[entity] as unknown as {
            putMany(rows: readonly object[]): Promise<void>;
            modifyMany(ids: readonly string[], fn: (docs: readonly ({ id: string } | undefined)[]) => readonly (object | null)[]): Promise<void>;
          };
          if (change.kind === "create") await c.putMany(change.rows);
          else await c.modifyMany(change.ids, (docs) => change.fold(docs));
        }
      },
      goals: {
        statusCounts: ({ projectId }) => Promise.all(STATUSES.map((s) => issues.count({ index: "byProjectStatus", eq: [projectId, s] }))),
        statusPage,
        drainedPage: statusPage,
        async deepWindow({ projectId, offset }) {
          const { ids } = await issues.queryIds({ index: "byNumber", eq: [projectId], reverse: true, limit: offset + LIMITS.page });
          return refs((await issues.getMany(ids.slice(offset))) as Issue[]);
        },
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
          const lists = await Promise.all(OPEN.map(async (s) => (await issues.query({ index: "byTriage", eq: [projectId, s], limit: LIMITS.page })).docs));
          const page = mergeTop(lists, (a, b) => a.priority - b.priority || a.createdAt - b.createdAt, LIMITS.page);
          const [ref, counts] = await Promise.all([refs(page), Promise.all(page.map((i) => comments.count({ index: "byIssue", eq: [i.id] })))]);
          return page.map((i, k) => ({ ...ref[k]!, status: i.status, priority: i.priority, comments: counts[k]! }));
        },
        async labelPage({ projectId, labelId }) {
          const lists = await Promise.all(
            OPEN.map(async (s) => (await issues.query({ index: "byLabel", eq: [labelId, projectId, s], reverse: true, limit: LIMITS.page })).docs),
          );
          return cards(mergeTop(lists, byUpdatedDesc, LIMITS.page));
        },
        async myIssues({ userId }) {
          const lists = await Promise.all(OPEN.map(async (s) => (await issues.query({ index: "byAssignee", eq: [userId, s], reverse: true, limit: LIMITS.page })).docs));
          return cards(mergeTop(lists, byUpdatedDesc, LIMITS.page));
        },
        recentActivity: async () => cards((await issues.query({ index: "byUpdated", reverse: true, limit: LIMITS.page })).docs),
        async assigneeLoad({ projectId }) {
          // docstore has no group-by and no index values in a query, so: one count of index entries per (person, open status).
          const people = (await users.query({})).docs;
          const counts = await Promise.all(
            people.map(async (u) => {
              const per = await Promise.all(OPEN.map((s) => issues.count({ index: "byProjectAssignee", eq: [projectId, u.id, s] })));
              return { name: u.name, open: per.reduce((a, b) => a + b, 0) };
            }),
          );
          return counts
            .filter((c) => c.open > 0)
            .sort((a, b) => b.open - a.open || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
            .slice(0, LIMITS.load);
        },
        search: async ({ projectId, text }) =>
          refs((await issues.query({ index: "byTitle", eq: [projectId], match: text, reverse: true, limit: LIMITS.search })).docs),
      },
    };
  },
});

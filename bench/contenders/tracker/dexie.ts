import Dexie, { type Table } from "dexie";
import { defineContender } from "../../core/types.ts";
import { LIMITS, OPEN, STATUSES, type Comment, type EntityName, type Issue, type IssueCard, type IssueRef, type Label, type Project, type User } from "../../datasets/tracker/types.ts";
import { changesOf, mergeTop } from "../../page/tracker.ts";

const byUpdatedDesc = (a: Issue, b: Issue) => b.updatedAt - a.updatedAt;
const distinct = <T>(xs: Iterable<T>) => [...new Set(xs)];
const { minKey, maxKey } = Dexie;

/**
 * IndexedDB keys reject null, so an issue with no assignee is simply absent
 * from the assignee indexes, which no goal reads for unassigned issues.
 * A multiEntry index cannot be part of a compound one, so a label page walks
 * the project's issues newest first and tests the labels. For the curated
 * bindings at small and large that reads fewer rows than `*labelIds`, which
 * spans every project and status.
 */
export default defineContender({
  family: "tracker",
  durability: "idb-default",
  fastPath:
    "Dexie 4; a table per entity, compound indexes; where().between().reverse().limit(), count(), offset(), keys() for one key-only range read of the group-by; joins = bulkGet of distinct foreign keys; each goal in one read transaction; a batch = one rw transaction of bulkGet and bulkPut/bulkDelete",
  engine: false,
  async open(name) {
    const db = new Dexie(`dexie-${name}`);
    db.version(1).stores({
      users: "id",
      projects: "id, &key",
      labels: "id",
      issues:
        "id, [projectId+status+updatedAt], &[projectId+number], [projectId+status+priority+createdAt], [assigneeId+status+updatedAt], [projectId+assigneeId+status], updatedAt, [projectId+updatedAt]",
      comments: "id, [issueId+createdAt]",
    });
    await db.open();
    const users = db.table("users") as Table<User, string>;
    const projects = db.table("projects") as Table<Project, string>;
    const labels = db.table("labels") as Table<Label, string>;
    const issues = db.table("issues") as Table<Issue, string>;
    const comments = db.table("comments") as Table<Comment, string>;
    const tables: Record<EntityName, Table<{ id: string }, string>> = { users, projects, labels, issues, comments };
    const read = <T>(fn: () => Promise<T>) => db.transaction("r", [users, projects, labels, issues, comments], fn);

    async function keysOf(list: readonly Issue[]): Promise<Map<string, string>> {
      const found = await projects.bulkGet(distinct(list.map((i) => i.projectId)));
      return new Map(found.map((p) => [p!.id, p!.key]));
    }

    async function cards(list: readonly Issue[]): Promise<IssueCard[]> {
      const [people, tags, keys] = await Promise.all([
        users.bulkGet(distinct(list.flatMap((i) => (i.assigneeId === null ? [] : [i.assigneeId])))),
        labels.bulkGet(distinct(list.flatMap((i) => i.labelIds))),
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

    const statusPage = ({ projectId, status }: { projectId: string; status: Issue["status"] }) =>
      read(async () =>
        cards(
          await issues
            .where("[projectId+status+updatedAt]")
            .between([projectId, status, minKey], [projectId, status, maxKey])
            .reverse()
            .limit(LIMITS.page)
            .toArray(),
        ),
      );

    return {
      async apply(tx) {
        const changes = changesOf(tx);
        await db.transaction("rw", [...changes.keys()].map((e) => tables[e]), async () => {
          for (const [entity, change] of changes) {
            const table = tables[entity];
            if (change.kind === "create") {
              await table.bulkPut(change.rows as { id: string }[]);
              continue;
            }
            const next = change.fold(await table.bulkGet(change.ids as string[]));
            const put = next.filter((r) => r !== null);
            const gone = change.ids.filter((_, k) => next[k] === null);
            if (put.length > 0) await table.bulkPut(put);
            if (gone.length > 0) await table.bulkDelete(gone as string[]);
          }
        });
      },
      goals: {
        statusCounts: ({ projectId }) =>
          read(() =>
            Promise.all(STATUSES.map((s) => issues.where("[projectId+status+updatedAt]").between([projectId, s, minKey], [projectId, s, maxKey]).count())),
          ),
        statusPage,
        drainedPage: statusPage,
        deepWindow: ({ projectId, offset }) =>
          read(async () =>
            refs(await issues.where("[projectId+number]").between([projectId, minKey], [projectId, maxKey]).reverse().offset(offset).limit(LIMITS.page).toArray()),
          ),
        issueThread: ({ projectKey, number }) =>
          read(async () => {
            const project = await projects.where("key").equals(projectKey).first();
            const issue = project && (await issues.where("[projectId+number]").equals([project.id, number]).first());
            if (!issue) return null;
            const [[card], thread] = await Promise.all([
              cards([issue]),
              comments.where("[issueId+createdAt]").between([issue.id, minKey], [issue.id, maxKey]).toArray(),
            ]);
            const authors = await users.bulkGet(distinct(thread.map((c) => c.authorId)));
            const author = new Map(authors.map((u) => [u!.id, u!.name]));
            return {
              issue: { ...card!, description: issue.description },
              comments: thread.map((c) => ({ id: c.id, author: author.get(c.authorId)!, body: c.body, createdAt: c.createdAt })),
            };
          }),
        triagePage: ({ projectId }) =>
          read(async () => {
            const lists = await Promise.all(
              OPEN.map((s) =>
                issues
                  .where("[projectId+status+priority+createdAt]")
                  .between([projectId, s, minKey, minKey], [projectId, s, maxKey, maxKey])
                  .limit(LIMITS.page)
                  .toArray(),
              ),
            );
            const page = mergeTop(lists, (a, b) => a.priority - b.priority || a.createdAt - b.createdAt, LIMITS.page);
            const [ref, counts] = await Promise.all([
              refs(page),
              Promise.all(page.map((i) => comments.where("[issueId+createdAt]").between([i.id, minKey], [i.id, maxKey]).count())),
            ]);
            return page.map((i, k) => ({ ...ref[k]!, status: i.status, priority: i.priority, comments: counts[k]! }));
          }),
        labelPage: ({ projectId, labelId }) =>
          read(async () =>
            cards(
              await issues
                .where("[projectId+updatedAt]")
                .between([projectId, minKey], [projectId, maxKey])
                .reverse()
                .filter((i) => i.labelIds.includes(labelId) && (OPEN as readonly string[]).includes(i.status))
                .limit(LIMITS.page)
                .toArray(),
            ),
          ),
        myIssues: ({ userId }) =>
          read(async () => {
            const lists = await Promise.all(
              OPEN.map((s) =>
                issues.where("[assigneeId+status+updatedAt]").between([userId, s, minKey], [userId, s, maxKey]).reverse().limit(LIMITS.page).toArray(),
              ),
            );
            return cards(mergeTop(lists, byUpdatedDesc, LIMITS.page));
          }),
        recentActivity: () => read(async () => cards(await issues.orderBy("updatedAt").reverse().limit(LIMITS.page).toArray())),
        assigneeLoad: ({ projectId }) =>
          read(async () => {
            const index = await issues.where("[projectId+assigneeId+status]").between([projectId, minKey, minKey], [projectId, maxKey, maxKey]).keys();
            const open = new Map<string, number>();
            for (const [, assigneeId, status] of index as unknown as [string, string, Issue["status"]][]) {
              if ((OPEN as readonly string[]).includes(status)) open.set(assigneeId, (open.get(assigneeId) ?? 0) + 1);
            }
            const people = await users.bulkGet([...open.keys()]);
            return people
              .map((u) => ({ name: u!.name, open: open.get(u!.id)! }))
              .sort((a, b) => b.open - a.open || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
              .slice(0, LIMITS.load);
          }),
        search: ({ projectId, text }) =>
          read(async () =>
            refs(
              await issues
                .where("[projectId+updatedAt]")
                .between([projectId, minKey], [projectId, maxKey])
                .reverse()
                .filter((i) => i.title.includes(text))
                .limit(LIMITS.search)
                .toArray(),
            ),
          ),
      },
      settle: async () => {},
      stats: async () => undefined,
      close: async () => db.close(),
    };
  },
});

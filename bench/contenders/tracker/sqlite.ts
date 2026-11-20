import { openBrowserWASQLiteOPFSDatabase } from "@tanstack/browser-db-sqlite-persistence";
import type { TrackerStore } from "../../core/families.ts";
import { defineContender } from "../../core/types.ts";
import { LIMITS, OPEN, STATUSES, type EntityName, type Event, type IssueCard, type IssueRef, type Priority, type Status } from "../../datasets/tracker/types.ts";

/** Columns per table. Issues' `labelIds` live in the `issue_labels` junction table. */
const COLUMNS: Record<EntityName, readonly string[]> = {
  users: ["id", "name", "email"],
  projects: ["id", "key", "name"],
  labels: ["id", "name", "color"],
  issues: ["id", "projectId", "number", "title", "description", "status", "priority", "assigneeId", "creatorId", "createdAt", "updatedAt"],
  comments: ["id", "issueId", "authorId", "body", "createdAt"],
};

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS labels (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL)",
  `CREATE TABLE IF NOT EXISTS issues (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL,
     description TEXT NOT NULL, status TEXT NOT NULL, priority INTEGER NOT NULL, assigneeId TEXT, creatorId TEXT NOT NULL,
     createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL)`,
  "CREATE TABLE IF NOT EXISTS issue_labels (issueId TEXT NOT NULL, labelId TEXT NOT NULL, PRIMARY KEY (issueId, labelId)) WITHOUT ROWID",
  "CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, issueId TEXT NOT NULL, authorId TEXT NOT NULL, body TEXT NOT NULL, createdAt INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS issues_project_status ON issues (projectId, status, updatedAt)",
  "CREATE UNIQUE INDEX IF NOT EXISTS issues_number ON issues (projectId, number)",
  // Sort keys before status: an IN over several statuses reads in sort order, filters status inside the index, and LIMIT stops at the page.
  "CREATE INDEX IF NOT EXISTS issues_triage ON issues (projectId, priority, createdAt, status)",
  "CREATE INDEX IF NOT EXISTS issues_assignee ON issues (assigneeId, updatedAt, status)",
  "CREATE INDEX IF NOT EXISTS issues_project_assignee ON issues (projectId, assigneeId, status)",
  "CREATE INDEX IF NOT EXISTS issues_updated ON issues (updatedAt)",
  "CREATE INDEX IF NOT EXISTS issues_project_updated ON issues (projectId, updatedAt)",
  "CREATE INDEX IF NOT EXISTS issue_labels_label ON issue_labels (labelId, issueId)",
  "CREATE INDEX IF NOT EXISTS comments_issue ON comments (issueId, createdAt)",
];

const OPEN_SQL = OPEN.map((s) => `'${s}'`).join(", ");
const KEY = "p.key || '-' || i.number";
const CARD = `i.id AS id, ${KEY} AS key, i.title AS title, i.status AS status, i.priority AS priority, i.updatedAt AS updatedAt, u.name AS assignee,
  (SELECT json_group_array(l.name) FROM issue_labels il JOIN labels l ON l.id = il.labelId WHERE il.issueId = i.id) AS labels`;
const JOINS = "JOIN projects p ON p.id = i.projectId LEFT JOIN users u ON u.id = i.assigneeId";
const REF = `i.id AS id, ${KEY} AS key, i.title AS title`;

type CardRow = { id: string; key: string; title: string; status: Status; priority: number; updatedAt: number; assignee: string | null; labels: string };
const card = (r: CardRow): IssueCard => ({
  id: r.id,
  key: r.key,
  title: r.title,
  status: r.status,
  priority: Number(r.priority) as Priority,
  updatedAt: Number(r.updatedAt),
  assignee: r.assignee ?? null,
  labels: (JSON.parse(r.labels) as string[]).sort(),
});
const ref = (r: IssueRef): IssueRef => ({ id: r.id, key: r.key, title: r.title });

const insertSql = (entity: EntityName) => {
  const cols = COLUMNS[entity];
  return `INSERT INTO ${entity} (${cols.join(", ")}) SELECT ${cols.map((c) => `json_extract(value, '$.${c}')`).join(", ")} FROM json_each(?)`;
};
const INSERT_LABELS = "INSERT INTO issue_labels (issueId, labelId) SELECT json_extract(i.value, '$.id'), l.value FROM json_each(?) AS i, json_each(json_extract(i.value, '$.labelIds')) AS l";

const updateSql = (entity: EntityName, cols: readonly string[]) =>
  `UPDATE ${entity} SET ${cols.map((c) => `${c} = CASE WHEN json_type(p.value, '$.${c}') IS NULL THEN ${entity}.${c} ELSE json_extract(p.value, '$.${c}') END`).join(", ")} FROM json_each(?) AS p WHERE ${entity}.id = p.key`;

type Row = Record<string, unknown> & { id: string; labelIds?: readonly string[] };
type Net = { drop: boolean; row: Row | null; set: Record<string, unknown> };

/**
 * A batch as SQL: the events of one row fold into its final state, then each entity
 * takes at most five statements (delete, unlabel, update, insert, label), however many events it holds.
 * Entities are separate tables, so the order between them does not matter.
 */
function statementsOf(events: readonly Event[]): [string, unknown[]][] {
  const byEntity = new Map<EntityName, Map<string, Net>>();
  for (const e of events) {
    const nets = byEntity.get(e.entity) ?? new Map<string, Net>();
    byEntity.set(e.entity, nets);
    const id = e.op === "create" ? e.row.id : e.id;
    const net = nets.get(id) ?? { drop: false, row: null, set: {} };
    nets.set(id, net);
    if (e.op === "create") {
      net.row = e.row as Row;
      net.set = {};
    } else if (e.op === "delete") {
      net.drop = true;
      net.row = null;
      net.set = {};
    } else if (net.row) net.row = { ...net.row, ...e.set };
    else net.set = { ...net.set, ...e.set };
  }
  const out: [string, unknown[]][] = [];
  for (const [entity, nets] of byEntity) {
    const gone: string[] = [];
    const unlabel: string[] = [];
    const rows: Row[] = [];
    const labelled: { id: string; labelIds: readonly string[] }[] = [];
    const patches: Record<string, Record<string, unknown>> = {};
    const cols = new Set<string>();
    for (const [id, net] of nets) {
      if (net.drop) {
        gone.push(id);
        if (entity === "issues") unlabel.push(id);
      }
      if (net.row) {
        rows.push(net.row);
        if (entity === "issues") labelled.push({ id, labelIds: net.row.labelIds ?? [] });
        continue;
      }
      const { labelIds, ...fields } = net.set as Record<string, unknown> & { labelIds?: readonly string[] };
      if (labelIds) {
        unlabel.push(id);
        labelled.push({ id, labelIds });
      }
      if (Object.keys(fields).length > 0) {
        patches[id] = fields;
        for (const c of Object.keys(fields)) cols.add(c);
      }
    }
    const ids = (list: readonly string[]) => [JSON.stringify(list)];
    if (gone.length > 0) out.push([`DELETE FROM ${entity} WHERE id IN (SELECT value FROM json_each(?))`, ids(gone)]);
    if (unlabel.length > 0) out.push(["DELETE FROM issue_labels WHERE issueId IN (SELECT value FROM json_each(?))", ids(unlabel)]);
    if (cols.size > 0) out.push([updateSql(entity, [...cols]), [JSON.stringify(patches)]]);
    if (rows.length > 0) out.push([insertSql(entity), [JSON.stringify(rows)]]);
    if (labelled.length > 0) out.push([INSERT_LABELS, [JSON.stringify(labelled)]]);
  }
  return out;
}

/** Opens the store with SQLite's default settings. */
async function openSqlite(name: string): Promise<TrackerStore> {
  const database = await openBrowserWASQLiteOPFSDatabase({ databaseName: `tracker-${name}.sqlite` });
  const sql = <T>(text: string, params: readonly unknown[] = []) => database.execute<T>(text, params);
  // Like an app's migration check: the schema statements run on the first open only, not on every fresh page.
  const [version] = await sql<{ user_version: number }>("PRAGMA user_version");
  if (!version?.user_version) {
    for (const statement of SCHEMA) await sql(statement);
    await sql("PRAGMA user_version = 1");
  }

  const statusPage = async ({ projectId, status }: { projectId: string; status: Status }) =>
    (await sql<CardRow>(`SELECT ${CARD} FROM issues i ${JOINS} WHERE i.projectId = ? AND i.status = ? ORDER BY i.updatedAt DESC LIMIT ${LIMITS.page}`, [projectId, status])).map(card);

  return {
    async apply(tx) {
      await sql("BEGIN");
      try {
        for (const [text, params] of statementsOf(tx.events)) await sql(text, params);
        await sql("COMMIT");
      } catch (err) {
        await sql("ROLLBACK");
        throw err;
      }
    },
    goals: {
      async statusCounts({ projectId }) {
        const rows = await sql<{ status: Status; n: number }>("SELECT status, count(*) AS n FROM issues WHERE projectId = ? GROUP BY status", [projectId]);
        const n = new Map(rows.map((r) => [r.status, Number(r.n)]));
        return STATUSES.map((s) => n.get(s) ?? 0);
      },
      statusPage,
      drainedPage: statusPage,
      deepWindow: async ({ projectId, offset }) =>
        (await sql<IssueRef>(`SELECT ${REF} FROM issues i JOIN projects p ON p.id = i.projectId WHERE i.projectId = ? ORDER BY i.number DESC LIMIT ${LIMITS.page} OFFSET ?`, [projectId, offset])).map(ref),
      async issueThread({ projectKey, number }) {
        const [issues, comments] = await Promise.all([
          sql<CardRow & { description: string }>(`SELECT ${CARD}, i.description AS description FROM issues i ${JOINS} WHERE p.key = ? AND i.number = ?`, [projectKey, number]),
          sql<{ id: string; author: string; body: string; createdAt: number }>(
            `SELECT c.id AS id, u.name AS author, c.body AS body, c.createdAt AS createdAt FROM comments c JOIN users u ON u.id = c.authorId
             WHERE c.issueId = (SELECT i.id FROM issues i JOIN projects p ON p.id = i.projectId WHERE p.key = ? AND i.number = ?) ORDER BY c.createdAt`,
            [projectKey, number],
          ),
        ]);
        const issue = issues[0];
        if (!issue) return null;
        return {
          issue: { ...card(issue), description: issue.description },
          comments: comments.map((c) => ({ id: c.id, author: c.author, body: c.body, createdAt: Number(c.createdAt) })),
        };
      },
      triagePage: async ({ projectId }) =>
        (
          await sql<IssueRef & { status: Status; priority: number; comments: number }>(
            `SELECT ${REF}, i.status AS status, i.priority AS priority, (SELECT count(*) FROM comments c WHERE c.issueId = i.id) AS comments
             FROM issues i JOIN projects p ON p.id = i.projectId WHERE i.projectId = ? AND i.status IN (${OPEN_SQL})
             ORDER BY i.priority, i.createdAt LIMIT ${LIMITS.page}`,
            [projectId],
          )
        ).map((r) => ({ ...ref(r), status: r.status, priority: Number(r.priority) as Priority, comments: Number(r.comments) })),
      labelPage: async ({ projectId, labelId }) =>
        (
          await sql<CardRow>(
            `SELECT ${CARD} FROM issue_labels lab JOIN issues i ON i.id = lab.issueId ${JOINS}
             WHERE lab.labelId = ? AND i.projectId = ? AND i.status IN (${OPEN_SQL}) ORDER BY i.updatedAt DESC LIMIT ${LIMITS.page}`,
            [labelId, projectId],
          )
        ).map(card),
      myIssues: async ({ userId }) =>
        (
          await sql<CardRow>(`SELECT ${CARD} FROM issues i ${JOINS} WHERE i.assigneeId = ? AND i.status IN (${OPEN_SQL}) ORDER BY i.updatedAt DESC LIMIT ${LIMITS.page}`, [
            userId,
          ])
        ).map(card),
      recentActivity: async () => (await sql<CardRow>(`SELECT ${CARD} FROM issues i ${JOINS} ORDER BY i.updatedAt DESC LIMIT ${LIMITS.page}`)).map(card),
      assigneeLoad: async ({ projectId }) =>
        (
          await sql<{ name: string; open: number }>(
            `SELECT u.name AS name, count(*) AS open FROM issues i JOIN users u ON u.id = i.assigneeId
             WHERE i.projectId = ? AND i.status IN (${OPEN_SQL}) GROUP BY i.assigneeId ORDER BY open DESC, u.name LIMIT ${LIMITS.load}`,
            [projectId],
          )
        ).map((r) => ({ name: r.name, open: Number(r.open) })),
      search: async ({ projectId, text }) =>
        (
          await sql<IssueRef>(
            `SELECT ${REF} FROM issues i JOIN projects p ON p.id = i.projectId WHERE i.projectId = ? AND instr(i.title, ?) > 0 ORDER BY i.updatedAt DESC LIMIT ${LIMITS.search}`,
            [projectId, text],
          )
        ).map(ref),
    },
    settle: async () => {},
    stats: async () => undefined,
    close: async () => {
      await database.close?.();
    },
  };
}

export default defineContender({
  family: "tracker",
  durability: "sqlite-full",
  fastPath:
    "wa-sqlite on OPFS (OPFSCoopSyncVFS) in a dedicated worker, opened by @tanstack/browser-db-sqlite-persistence, SQLite's default settings; normalized tables, issue_labels junction, 9 secondary indexes; one SQL statement per goal (two for a thread); a batch = one transaction, folded per row and run as at most five json_each statements per entity (delete, unlabel, UPDATE FROM, INSERT, label)",
  engine: false,
  open: openSqlite,
});

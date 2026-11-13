import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import type { SortField } from "../client/filter.ts";
import type { ColumnArgs, CommentEntity, FilterArgs, IssueFields, IssuePatch, PriorityCode, StatusCode, StatusCounts, WindowArgs } from "../domain/model.ts";

/**
 * The columns each sort orders by. A list orders by them and then `id`, all in one direction, and reads them from
 * the sort's own index (`issue_by_<sort>`), so a window walks one index and never sorts.
 */
const SORTS = {
  modified: ["modified"],
  created: ["created"],
  title: ["title"],
  priority: ["priority", "status", "modified"],
  status: ["status", "kanbanorder"],
} as const satisfies Record<SortField, readonly (keyof IssueFields)[]>;

/** Every sort index also holds the filtered columns, so a filter or search is checked in the index without reading rows. */
const FILTERED = ["status", "priority", "title"] as const;

const sortIndex = (sort: SortField) =>
  `CREATE INDEX IF NOT EXISTS issue_by_${sort} ON issue (${[...SORTS[sort], "id", ...FILTERED.filter((c) => !(SORTS[sort] as readonly string[]).includes(c))].join(", ")});`;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS issue (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, status INTEGER NOT NULL, priority INTEGER NOT NULL,
  kanbanorder TEXT NOT NULL, username TEXT NOT NULL, created INTEGER NOT NULL, modified INTEGER NOT NULL,
  description TEXT NOT NULL);
${(Object.keys(SORTS) as SortField[]).map(sortIndex).join("\n")}
CREATE TABLE IF NOT EXISTS comment (
  id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, body TEXT NOT NULL, username TEXT NOT NULL, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS comment_by_issue ON comment (issue_id, created, id);
CREATE TABLE IF NOT EXISTS receipt (scope TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (scope, id)) WITHOUT ROWID;
`;

const FIELDS = "id, title, status, priority, kanbanorder, username, created, modified";

export type IssueRecord = IssueFields & { readonly description?: string; readonly comments?: readonly CommentEntity[] };
export type Page = { readonly rows: readonly IssueFields[]; readonly more: boolean };

const statements = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

function prepare(db: DatabaseSync, sql: string): StatementSync {
  let cache = statements.get(db);
  if (!cache) statements.set(db, (cache = new Map()));
  let statement = cache.get(sql);
  if (!statement) cache.set(sql, (statement = db.prepare(sql)));
  return statement;
}

const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/** `LIKE` treats `%` and `_` as wildcards; escaped, the query matches as typed, ignoring ASCII case. */
const contains = (q: string) => `%${q.replace(/[\\%_]/g, "\\$&")}%`;

function where(filter: FilterArgs, extra: readonly string[] = []): { sql: string; params: SQLInputValue[] } {
  const terms = [...extra];
  const params: SQLInputValue[] = [];
  if (filter.status.length > 0) {
    terms.push(`status IN (${marks(filter.status.length)})`);
    params.push(...filter.status);
  }
  if (filter.priority.length > 0) {
    terms.push(`priority IN (${marks(filter.priority.length)})`);
    params.push(...filter.priority);
  }
  if (filter.q !== "") {
    terms.push(`title LIKE ? ESCAPE '\\'`);
    params.push(contains(filter.q));
  }
  return { sql: terms.length > 0 ? `WHERE ${terms.join(" AND ")}` : "", params };
}

const orderBy = (sort: SortField, dir: "asc" | "desc") => [...SORTS[sort], "id"].map((c) => `${c} ${dir}`).join(", ");

const toFields = (r: Record<string, unknown>): IssueFields => ({
  id: r.id as string,
  title: r.title as string,
  status: r.status as StatusCode,
  priority: r.priority as PriorityCode,
  kanbanorder: r.kanbanorder as string,
  username: r.username as string,
  created: r.created as number,
  modified: r.modified as number,
});

export function windowSql(args: WindowArgs): { sql: string; params: SQLInputValue[] } {
  const w = where(args);
  return {
    sql: `SELECT ${FIELDS} FROM issue INDEXED BY issue_by_${args.sort} ${w.sql} ORDER BY ${orderBy(args.sort, args.dir)} LIMIT ? OFFSET ?`,
    params: [...w.params, args.limit, args.offset],
  };
}

export function readWindow(db: DatabaseSync, args: WindowArgs): Page {
  const { sql, params } = windowSql({ ...args, limit: args.limit + 1 });
  const rows = prepare(db, sql).all(...params).map(toFields);
  return { rows: rows.slice(0, args.limit), more: rows.length > args.limit };
}

/** A column's issues by `kanbanorder`, the `first` after the issue `after` names (`[kanbanorder, id]`). */
export function readColumn(db: DatabaseSync, args: ColumnArgs, after: readonly [string, string] | undefined): Page {
  const w = where({ status: [args.column], priority: args.priority, q: args.q }, after ? ["(kanbanorder, id) > (?, ?)"] : []);
  const sql = `SELECT ${FIELDS} FROM issue INDEXED BY issue_by_status ${w.sql} ORDER BY kanbanorder, id LIMIT ?`;
  const rows = prepare(db, sql)
    .all(...(after ?? []), ...w.params, args.first + 1)
    .map(toFields);
  return { rows: rows.slice(0, args.first), more: rows.length > args.first };
}

export function columnTop(db: DatabaseSync, status: StatusCode): string | null {
  const row = prepare(db, "SELECT kanbanorder FROM issue INDEXED BY issue_by_status WHERE status = ? ORDER BY kanbanorder LIMIT 1").get(status);
  return row ? (row.kanbanorder as string) : null;
}

export function countByStatus(db: DatabaseSync, filter: FilterArgs): StatusCounts {
  const w = where(filter);
  const counts: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  for (const r of prepare(db, `SELECT status, COUNT(*) AS n FROM issue ${w.sql} GROUP BY status`).all(...w.params)) {
    counts[r.status as StatusCode] = r.n as number;
  }
  return counts;
}

/** The issues `ids` names that exist, with their description and comments (oldest first) when asked for. */
export function readIssues(db: DatabaseSync, ids: readonly string[], include: { description: boolean; comments: boolean }): IssueRecord[] {
  if (ids.length === 0) return [];
  const issues = prepare(db, `SELECT ${FIELDS}, description FROM issue WHERE id IN (${marks(ids.length)})`)
    .all(...ids)
    .map((r) => ({ ...toFields(r), ...(include.description && { description: r.description as string }) }));
  if (!include.comments) return issues;
  const comments = Map.groupBy(
    prepare(db, `SELECT id, issue_id, body, username, created FROM comment WHERE issue_id IN (${marks(ids.length)}) ORDER BY created, id`).all(...ids),
    (r) => r.issue_id as string,
  );
  return issues.map((issue) => ({ ...issue, comments: (comments.get(issue.id) ?? []).map(toComment) }));
}

const toComment = (r: Record<string, unknown>): CommentEntity => ({
  __typename: "Comment",
  id: r.id as string,
  body: r.body as string,
  username: r.username as string,
  created: r.created as number,
});

export function readComments(db: DatabaseSync, ids: readonly string[]): CommentEntity[] {
  if (ids.length === 0) return [];
  return prepare(db, `SELECT id, body, username, created FROM comment WHERE id IN (${marks(ids.length)})`).all(...ids).map(toComment);
}

/** Applies `patch` and stamps `modified`. False when there is no such issue. */
export function updateIssue(db: DatabaseSync, id: string, patch: IssuePatch, now: number): boolean {
  const fields = Object.entries(patch).filter(([, v]) => v !== undefined);
  const sql = `UPDATE issue SET ${[...fields.map(([f]) => `${f} = ?`), "modified = ?"].join(", ")} WHERE id = ?`;
  return prepare(db, sql).run(...fields.map(([, v]) => v as SQLInputValue), now, id).changes > 0;
}

export function insertIssue(db: DatabaseSync, issue: IssueFields & { readonly description: string }): void {
  prepare(db, `INSERT INTO issue (${FIELDS}, description) VALUES (${marks(9)})`).run(
    issue.id,
    issue.title,
    issue.status,
    issue.priority,
    issue.kanbanorder,
    issue.username,
    issue.created,
    issue.modified,
    issue.description,
  );
}

export function deleteIssue(db: DatabaseSync, id: string): void {
  prepare(db, "DELETE FROM comment WHERE issue_id = ?").run(id);
  prepare(db, "DELETE FROM issue WHERE id = ?").run(id);
}

export function insertComment(db: DatabaseSync, c: { id: string; issueId: string; body: string; username: string; created: number }): void {
  prepare(db, "INSERT INTO comment (id, issue_id, body, username, created) VALUES (?, ?, ?, ?, ?)").run(c.id, c.issueId, c.body, c.username, c.created);
}

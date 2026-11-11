import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue, type StatementSync } from "node:sqlite";
import { commentKey, type PriorityCode, type ServerRow, type StatusCode, STREAMS, type Stream } from "../domain/model.ts";

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS issue (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, status INTEGER NOT NULL, priority INTEGER NOT NULL,
  kanbanorder TEXT NOT NULL, username TEXT NOT NULL, created INTEGER NOT NULL, modified INTEGER NOT NULL,
  deleted INTEGER NOT NULL, version INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS issue_version ON issue (version);
CREATE TABLE IF NOT EXISTS body (
  id TEXT PRIMARY KEY, description TEXT NOT NULL, version INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS body_version ON body (version);
CREATE TABLE IF NOT EXISTS comment (
  id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, body TEXT NOT NULL, username TEXT NOT NULL,
  created INTEGER NOT NULL, deleted INTEGER NOT NULL, version INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS comment_version ON comment (version);
CREATE INDEX IF NOT EXISTS comment_issue ON comment (issue_id);
`;

type Dbrow = Record<string, SQLOutputValue>;

/** How one stream's row maps to its table. Column 0 is `id`, the last is `version`. */
export interface Codec<R> {
  readonly table: string;
  readonly columns: readonly string[];
  fromDb(r: Dbrow): R;
  params(r: R): SQLInputValue[];
}

type Codecs = { [S in Stream]: Codec<ServerRow<S>> };

export const CODECS: Codecs = {
  issues: {
    table: "issue",
    columns: ["id", "title", "status", "priority", "kanbanorder", "username", "created", "modified", "deleted", "version"],
    fromDb: (r) => ({
      id: r.id as string,
      title: r.title as string,
      status: r.status as StatusCode,
      priority: r.priority as PriorityCode,
      kanbanorder: r.kanbanorder as string,
      username: r.username as string,
      created: r.created as number,
      modified: r.modified as number,
      deleted: r.deleted === 1,
      version: r.version as number,
    }),
    params: (r) => [r.id, r.title, r.status, r.priority, r.kanbanorder, r.username, r.created, r.modified, r.deleted ? 1 : 0, r.version],
  },
  bodies: {
    table: "body",
    columns: ["id", "description", "version"],
    fromDb: (r) => ({ id: r.id as string, description: r.description as string, version: r.version as number }),
    params: (r) => [r.id, r.description, r.version],
  },
  comments: {
    table: "comment",
    columns: ["id", "issue_id", "body", "username", "created", "deleted", "version"],
    fromDb: (r) => ({
      key: commentKey(r.issue_id as string, r.id as string),
      id: r.id as string,
      issue_id: r.issue_id as string,
      body: r.body as string,
      username: r.username as string,
      created: r.created as number,
      deleted: r.deleted === 1,
      version: r.version as number,
    }),
    params: (r) => [r.id, r.issue_id, r.body, r.username, r.created, r.deleted ? 1 : 0, r.version],
  },
};

export interface StreamStatements {
  get: StatementSync;
  insert: StatementSync;
  update: StatementSync;
  page: StatementSync;
  group: StatementSync;
  newer: StatementSync;
}
export interface Statements {
  streams: Record<Stream, StreamStatements>;
  commentsOf: StatementSync;
  getMeta: StatementSync;
  setMeta: StatementSync;
  issueExists: StatementSync;
}

const cache = new WeakMap<DatabaseSync, Statements>();

export function statements(db: DatabaseSync): Statements {
  let s = cache.get(db);
  if (s) return s;
  const streams = {} as Record<Stream, StreamStatements>;
  for (const stream of STREAMS) {
    const { table, columns } = CODECS[stream];
    const cols = columns.join(", ");
    streams[stream] = {
      get: db.prepare(`SELECT ${cols} FROM ${table} WHERE id = ?`),
      insert: db.prepare(`INSERT INTO ${table} (${cols}) VALUES (${columns.map(() => "?").join(", ")})`),
      update: db.prepare(`UPDATE ${table} SET ${columns.slice(1).map((c) => `${c} = ?`).join(", ")} WHERE id = ?`),
      page: db.prepare(`SELECT ${cols} FROM ${table} WHERE version > ? ORDER BY version LIMIT ?`),
      group: db.prepare(`SELECT ${cols} FROM ${table} WHERE version = ?`),
      newer: db.prepare(`SELECT 1 AS found FROM ${table} WHERE version > ? LIMIT 1`),
    };
  }
  s = {
    streams,
    commentsOf: db.prepare(`SELECT ${CODECS.comments.columns.join(", ")} FROM comment WHERE issue_id = ?`),
    getMeta: db.prepare("SELECT v FROM meta WHERE k = ?"),
    setMeta: db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v"),
    issueExists: db.prepare("SELECT 1 AS found FROM issue WHERE id = ?"),
  };
  cache.set(db, s);
  return s;
}

export function openServerDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000");
  const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (current !== 0 && current !== SCHEMA_VERSION) throw new Error(`${path}: schema version ${current}, expected ${SCHEMA_VERSION}`);
  db.exec(SCHEMA);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  const { setMeta, getMeta } = statements(db);
  if (getMeta.get("epoch") === undefined) {
    setMeta.run("epoch", randomUUID());
    setMeta.run("head", 0);
  }
  return db;
}

export function readHead(db: DatabaseSync): number {
  return (statements(db).getMeta.get("head") as { v: number }).v;
}
export function writeHead(db: DatabaseSync, head: number): void {
  statements(db).setMeta.run("head", head);
}
export function readEpoch(db: DatabaseSync): string {
  return (statements(db).getMeta.get("epoch") as { v: string }).v;
}

/** Empty every table and start a new epoch, so clients that held the old data notice and start over. Run it inside a transaction. */
export function resetStore(db: DatabaseSync): string {
  const epoch = randomUUID();
  for (const stream of STREAMS) db.exec(`DELETE FROM ${CODECS[stream].table}`);
  const { setMeta } = statements(db);
  setMeta.run("epoch", epoch);
  setMeta.run("head", 0);
  return epoch;
}

export function defaultDbPath(): string {
  return resolve(process.env.LINEARLITE_DB ?? "data/linearlite.db");
}

const SHARED = Symbol.for("linearlite.serverDb");
/** The server's one connection. Kept on globalThis so a dev-server module reload does not open a second one. */
export function serverDb(): DatabaseSync {
  const g = globalThis as { [SHARED]?: DatabaseSync };
  return (g[SHARED] ??= openServerDb(defaultDbPath()));
}

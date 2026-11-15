import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue, type StatementSync } from "node:sqlite";
import type { ServerRow } from "../domain/model.ts";
import { STREAMS, type Stream, streamOf } from "../domain/stores.ts";

const SCHEMA_VERSION = 1;

const SQL_TYPE = { text: "TEXT", int: "INTEGER", bool: "INTEGER" } as const;

function tableDdl(stream: Stream): string[] {
  const { table, fields } = streamOf(stream);
  const columns = Object.entries(fields).map(([name, f]) => `${name} ${SQL_TYPE[f.sql]}${name === "id" ? " PRIMARY KEY" : " NOT NULL"}`);
  const indexes = [`${table}_version ON ${table} (version)`];
  for (const [name, f] of Object.entries(fields)) if (f.indexed) indexes.push(`${f.indexed} ON ${table} (${name})`);
  return [`CREATE TABLE IF NOT EXISTS ${table} (${columns.join(", ")});`, ...indexes.map((i) => `CREATE INDEX IF NOT EXISTS ${i};`)];
}

const SCHEMA = ["CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v) WITHOUT ROWID;", ...STREAMS.flatMap(tableDdl)].join("\n");

type Dbrow = Record<string, SQLOutputValue>;

interface Codec<R> {
  readonly table: string;
  readonly columns: readonly string[];
  fromDb(r: Dbrow): R;
  params(r: R): SQLInputValue[];
}

type Codecs = { [S in Stream]: Codec<ServerRow<S>> };

function codec<S extends Stream>(stream: S): Codec<ServerRow<S>> {
  const { table, fields, derive } = streamOf(stream);
  const columns = Object.keys(fields);
  const bools = columns.map((c) => fields[c]!.sql === "bool");
  return {
    table,
    columns,
    fromDb(r) {
      const row: Record<string, unknown> = {};
      columns.forEach((c, i) => (row[c] = bools[i] ? r[c] === 1 : r[c]));
      return { ...derive?.(row as never), ...row } as ServerRow<S>;
    },
    params(r) {
      const row = r as Record<string, unknown>;
      return columns.map((c, i) => (bools[i] ? (row[c] ? 1 : 0) : row[c])) as SQLInputValue[];
    },
  };
}

export const CODECS = Object.fromEntries(STREAMS.map((s) => [s, codec(s)])) as Codecs;

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
    commentsOf: db.prepare(`SELECT ${CODECS.comments.columns.join(", ")} FROM ${CODECS.comments.table} WHERE issue_id = ?`),
    getMeta: db.prepare("SELECT v FROM meta WHERE k = ?"),
    setMeta: db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v"),
    issueExists: db.prepare(`SELECT 1 AS found FROM ${CODECS.issues.table} WHERE id = ?`),
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
export function serverDb(): DatabaseSync {
  const g = globalThis as { [SHARED]?: DatabaseSync };
  return (g[SHARED] ??= openServerDb(defaultDbPath()));
}

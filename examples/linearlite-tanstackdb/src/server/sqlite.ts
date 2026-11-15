import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue, type StatementSync } from "node:sqlite";
import type { ServerRow } from "../domain/model.ts";
import { STREAMS, type Stream, streamOf } from "../domain/stores.ts";
import { generate } from "./generate.ts";
import { syncServer, type SyncServer, type Tables } from "./protocol.ts";

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

const CODECS = Object.fromEntries(STREAMS.map((s) => [s, codec(s)])) as Codecs;

type StreamStatements = Record<"get" | "put" | "page" | "group" | "newer", StatementSync>;

export function sqliteTables(db: DatabaseSync): Tables {
  const streams = {} as Record<Stream, StreamStatements>;
  for (const stream of STREAMS) {
    const { table, columns } = CODECS[stream];
    const cols = columns.join(", ");
    streams[stream] = {
      get: db.prepare(`SELECT ${cols} FROM ${table} WHERE id = ?`),
      put: db.prepare(
        `INSERT INTO ${table} (${cols}) VALUES (${columns.map(() => "?").join(", ")}) ON CONFLICT (id) DO UPDATE SET ${columns.slice(1).map((c) => `${c} = excluded.${c}`).join(", ")}`,
      ),
      page: db.prepare(`SELECT ${cols} FROM ${table} WHERE version > ? ORDER BY version LIMIT ?`),
      group: db.prepare(`SELECT ${cols} FROM ${table} WHERE version = ?`),
      newer: db.prepare(`SELECT 1 AS found FROM ${table} WHERE version > ? LIMIT 1`),
    };
  }
  const commentsOf = db.prepare(`SELECT ${CODECS.comments.columns.join(", ")} FROM ${CODECS.comments.table} WHERE issue_id = ?`);
  const getMeta = db.prepare("SELECT v FROM meta WHERE k = ?");
  const setHead = db.prepare("UPDATE meta SET v = ? WHERE k = 'head'");
  return {
    head: () => (getMeta.get("head") as { v: number }).v,
    setHead: (head) => void setHead.run(head),
    epoch: () => (getMeta.get("epoch") as { v: string }).v,
    transaction(fn) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const out = fn();
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    page: (stream, after, limit) => streams[stream].page.all(after, limit).map((r) => CODECS[stream].fromDb(r)),
    group: (stream, version) => streams[stream].group.all(version).map((r) => CODECS[stream].fromDb(r)),
    newer: (stream, version) => streams[stream].newer.get(version) !== undefined,
    get(stream, id) {
      const found = streams[stream].get.get(id);
      return found && CODECS[stream].fromDb(found);
    },
    put: (stream, row) => void streams[stream].put.run(...CODECS[stream].params(row)),
    commentsOf: (issue) => commentsOf.all(issue).map((r) => CODECS.comments.fromDb(r)),
  };
}

export function openServerDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000");
  const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (current !== 0 && current !== SCHEMA_VERSION) throw new Error(`${path}: schema version ${current}, expected ${SCHEMA_VERSION}`);
  db.exec(SCHEMA);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  db.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('epoch', ?), ('head', 0)").run(crypto.randomUUID());
  return db;
}

/** Replaces every row with `generate(issues, seed)`'s, under a new epoch. */
export function seedDb(db: DatabaseSync, issues: number, seed = 1): { rows: number; head: number } {
  const { rows, head } = generate(issues, seed);
  const tables = sqliteTables(db);
  tables.transaction(() => {
    for (const stream of STREAMS) db.exec(`DELETE FROM ${CODECS[stream].table}`);
    db.prepare("UPDATE meta SET v = ? WHERE k = 'epoch'").run(crypto.randomUUID());
    for (const stream of STREAMS) for (const row of rows[stream]) tables.put(stream, row);
    tables.setHead(head);
  });
  return { rows: head, head };
}

export function defaultDbPath(): string {
  return resolve(process.env.LINEARLITE_DB ?? "data/linearlite.db");
}

const SHARED = Symbol.for("linearlite.server");
/** The app's server, over the database at `defaultDbPath()`. */
export function appServer(): SyncServer {
  const g = globalThis as { [SHARED]?: SyncServer };
  return (g[SHARED] ??= syncServer(sqliteTables(openServerDb(defaultDbPath()))));
}

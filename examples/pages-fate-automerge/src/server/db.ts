import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS page (
  seq       INTEGER PRIMARY KEY,
  id        TEXT NOT NULL UNIQUE,
  parent_id TEXT REFERENCES page(id) ON DELETE CASCADE,
  title     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS page_children ON page (parent_id, seq);
CREATE TABLE IF NOT EXISTS receipt (scope TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (scope, id)) WITHOUT ROWID;
`;

export function openServerDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON");
  const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (current !== 0 && current !== SCHEMA_VERSION) throw new Error(`${path}: schema version ${current}, expected ${SCHEMA_VERSION}`);
  db.exec(SCHEMA);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return db;
}

export function defaultDbPath(): string {
  return resolve(process.env.PAGES_DB ?? "data/pages.db");
}

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA } from "./issues.ts";

const SCHEMA_VERSION = 1;

export function openServerDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000");
  const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (current !== 0 && current !== SCHEMA_VERSION) throw new Error(`${path}: schema version ${current}, expected ${SCHEMA_VERSION}`);
  db.exec(SCHEMA);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return db;
}

export function defaultDbPath(): string {
  return resolve(process.env.LINEARLITE_FATE_DB ?? "data/linearlite-fate.db");
}

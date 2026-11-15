import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { BrowserWASQLiteDatabase } from "@tanstack/browser-db-sqlite-persistence";

/** A value as the browser package's worker binds it: booleans as 0 or 1, undefined as null. */
const bindable = (value: unknown) => (typeof value === "boolean" ? Number(value) : value === undefined ? null : value) as SQLInputValue;

/**
 * Node's built-in SQLite behind the `execute` that `openBrowserWASQLiteOPFSDatabase` returns, so the SQLite backend
 * runs under `node --test` on the browser package's own persistence code. Only the engine differs: wa-sqlite on OPFS
 * in a dedicated WebWorker there, the SQLite Node links here.
 */
export function nodeSqlite(path = ":memory:"): BrowserWASQLiteDatabase & { close(): void } {
  const db = new DatabaseSync(path);
  return {
    execute: async <R>(sql: string, params: readonly unknown[] = []) => db.prepare(sql).all(...params.map(bindable)) as R[],
    close: () => db.close(),
  };
}

import type { DatabaseSync } from "node:sqlite";
import { generate } from "../../scripts/generate.ts";
import { commentKey, PRIORITIES, STATUSES } from "../domain/model.ts";
import { CODECS, resetStore, statements, writeHead } from "./db.ts";

/**
 * Replace the store's contents with `generate(count)` in one transaction and start a new epoch. Versions are
 * stamped in `modified` order, an issue then its body then its comments, so the first sync fills the
 * most recently touched issues last and every row has a distinct version.
 */
export function seedDb(db: DatabaseSync, count: number, seed = 1): { rows: number; head: number } {
  const data = generate(count, seed);
  const commentsOf = Map.groupBy(data.comments, (c) => c.issue_id);
  const { issues, bodies, comments } = statements(db).streams;
  const issueParams = CODECS.issues.params;
  const bodyParams = CODECS.bodies.params;
  const commentParams = CODECS.comments.params;
  let version = 0;
  let rows = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    resetStore(db);
    for (const s of data.issues.toSorted((a, b) => a.modified - b.modified)) {
      issues.insert.run(
        ...issueParams({
          id: s.id,
          title: s.title,
          status: STATUSES.indexOf(s.status) as 0 | 1 | 2 | 3 | 4,
          priority: PRIORITIES.indexOf(s.priority) as 0 | 1 | 2 | 3 | 4,
          kanbanorder: s.kanbanorder,
          username: s.username,
          created: s.created,
          modified: s.modified,
          deleted: false,
          version: ++version,
        }),
      );
      bodies.insert.run(...bodyParams({ id: s.id, description: s.description, version: ++version }));
      rows += 2;
      for (const c of commentsOf.get(s.id) ?? []) {
        comments.insert.run(
          ...commentParams({ key: commentKey(c.issue_id, c.id), id: c.id, issue_id: c.issue_id, body: c.body, username: c.username, created: c.created, deleted: false, version: ++version }),
        );
        rows++;
      }
    }
    writeHead(db, version);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { rows, head: version };
}

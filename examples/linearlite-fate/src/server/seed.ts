import type { DatabaseSync } from "node:sqlite";
import { generate } from "../../scripts/generate.ts";
import { PRIORITIES, STATUSES, type PriorityCode, type StatusCode } from "../domain/model.ts";
import { insertComment, insertIssue } from "./issues.ts";

/** Replaces every issue and comment with `count` generated issues; the same `seed` gives the original example's data. */
export function seedDb(db: DatabaseSync, count: number, seed = 1): { issues: number; comments: number } {
  const data = generate(count, seed);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM comment; DELETE FROM issue; DELETE FROM receipt");
    for (const s of data.issues) {
      insertIssue(db, {
        id: s.id,
        title: s.title,
        status: STATUSES.indexOf(s.status) as StatusCode,
        priority: PRIORITIES.indexOf(s.priority) as PriorityCode,
        kanbanorder: s.kanbanorder,
        username: s.username,
        created: s.created,
        modified: s.modified,
        description: s.description,
      });
    }
    for (const c of data.comments) insertComment(db, { id: c.id, issueId: c.issue_id, body: c.body, username: c.username, created: c.created });
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { issues: data.issues.length, comments: data.comments.length };
}

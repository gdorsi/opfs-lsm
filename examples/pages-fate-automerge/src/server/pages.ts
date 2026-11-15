import type { DatabaseSync } from "node:sqlite";
import type { NewPage } from "../model/tree.ts";
import type { PageId } from "../model/types.ts";

export type PageRow = { readonly id: PageId; readonly parentId: PageId | null; readonly title: string };

/** The parent of a new page is not in the table: it never was, or it was deleted. */
export class NoParent extends Error {}

const SQLITE_CONSTRAINT_FOREIGNKEY = 787;
const COLUMNS = "id, parent_id AS parentId, title";

export function insertPage(db: DatabaseSync, page: NewPage): void {
  try {
    db.prepare("INSERT INTO page (id, parent_id, title) VALUES (?, ?, ?)").run(page.id, page.parentId, page.title);
  } catch (error) {
    if ((error as { errcode?: number }).errcode === SQLITE_CONSTRAINT_FOREIGNKEY) throw new NoParent(`no page ${page.parentId}`, { cause: error });
    throw error;
  }
}

/** False when the page is gone. */
export function setTitle(db: DatabaseSync, id: PageId, title: string): boolean {
  return db.prepare("UPDATE page SET title = ? WHERE id = ?").run(title, id).changes > 0;
}

/** Removes the page and every page under it. A missing id removes nothing. */
export function deleteSubtree(db: DatabaseSync, id: PageId): void {
  db.prepare("DELETE FROM page WHERE id = ?").run(id);
}

/** One page of `parent`'s children after the cursor `after` (a seq). An unknown parent has no children. */
export function readChildren(
  db: DatabaseSync,
  args: { readonly parent: PageId | null; readonly first: number; readonly after?: number },
): { readonly rows: readonly (PageRow & { readonly seq: number })[]; readonly more: boolean } {
  const rows = db
    .prepare(`SELECT seq, ${COLUMNS} FROM page WHERE parent_id IS ? AND seq > ? ORDER BY seq LIMIT ?`)
    .all(args.parent, args.after ?? 0, args.first + 1) as unknown as (PageRow & { seq: number })[];
  return { rows: rows.slice(0, args.first), more: rows.length > args.first };
}

export function readPages(db: DatabaseSync, ids: readonly string[]): PageRow[] {
  if (ids.length === 0) return [];
  return db.prepare(`SELECT ${COLUMNS} FROM page WHERE id IN (${ids.map(() => "?").join(", ")})`).all(...ids) as unknown as PageRow[];
}

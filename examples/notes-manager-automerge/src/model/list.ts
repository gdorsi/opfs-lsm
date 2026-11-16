/**
 * The list doc: every page's parent and title, keyed by page id. The tree is
 * read from it, and each read reuses the arrays and page objects of the read
 * before that did not change, so a selector over one level or one page keeps
 * its value while another page changes.
 */
import type { DocumentId } from "@automerge/automerge-repo";
import type { Page, PageId, Tree } from "./types.ts";

/** One id for every database: each database holds its own list doc. */
export const LIST_ID = "4SnAnQR5MgZtHgdXbqUJZ6C4ueps" as DocumentId;
export const MAX_TITLE = 500;

/** `title` is Automerge text, so concurrent renames merge per character. */
export type PageEntry = { parent: PageId | null; title: string; created: number };
export type ListDoc = { pages: { [id: string]: PageEntry } };

const NONE: readonly PageId[] = Object.freeze([]);

export class ListTree implements Tree {
  readonly #levels: ReadonlyMap<PageId | null, readonly PageId[]>;
  readonly #pages: ReadonlyMap<PageId, Page>;

  constructor(levels: ReadonlyMap<PageId | null, readonly PageId[]>, pages: ReadonlyMap<PageId, Page>) {
    this.#levels = levels;
    this.#pages = pages;
  }

  children(parent: PageId | null): readonly PageId[] {
    return this.#levels.get(parent) ?? NONE;
  }

  page(id: PageId): Page | undefined {
    return this.#pages.get(id);
  }

  subtree(id: PageId): readonly PageId[] {
    if (!this.#pages.has(id)) return NONE;
    const ids = [id];
    for (let i = 0; i < ids.length; i++) ids.push(...this.children(ids[i]!));
    return ids;
  }

  /** Every reachable id. */
  ids(): IterableIterator<PageId> {
    return this.#pages.keys();
  }
}

export function readTree(pages: ListDoc["pages"], before?: ListTree): ListTree {
  const byParent = new Map<PageId | null, PageId[]>();
  for (const id in pages) {
    const parent = pages[id]!.parent;
    const siblings = byParent.get(parent);
    if (siblings) siblings.push(id as PageId);
    else byParent.set(parent, [id as PageId]);
  }
  const levels = new Map<PageId | null, readonly PageId[]>();
  const reached = new Map<PageId, Page>();
  const oldestFirst = (a: PageId, b: PageId) => pages[a]!.created - pages[b]!.created || (a < b ? -1 : a > b ? 1 : 0);
  for (const queue: (PageId | null)[] = [null]; queue.length > 0; ) {
    const parent = queue.pop()!;
    const ids = byParent.get(parent)?.sort(oldestFirst);
    if (!ids) continue;
    const old = before?.children(parent);
    levels.set(parent, old && old.length === ids.length && old.every((id, i) => id === ids[i]) ? old : ids);
    for (const id of ids) {
      const { title } = pages[id]!;
      const seen = before?.page(id);
      reached.set(id, seen && seen.title === title && seen.parent === parent ? seen : { id, parent, title });
      queue.push(id);
    }
  }
  return new ListTree(levels, reached);
}

import { DEFAULT_FILTER, type Filter, type Issue } from "./model.ts";
import { keeps, orderOf, viewOf, type Store, type View } from "./store.ts";

export const ROW = 40;
const PAGE = 50;
const OVERSCAN = 8;

/** One issue of a write: as the list held it before, and as it is stored now. Absent on a side where it does not exist. */
export type Change = { readonly before: Issue | undefined; readonly after: Issue | undefined };

/**
 * What the list draws: its height in rows, and the places in view with their issue, or none while its page is unread.
 * `none` is set when a list read to its end holds no issue.
 */
type ListWindow = {
  readonly count: number;
  readonly rows: readonly { readonly at: number; readonly issue: Issue | undefined }[];
  readonly none: boolean;
  /** Moves when the list starts over from its first row, so the scroller goes back to the top. */
  readonly top: number;
};

/**
 * The issue list: only the rows in view are drawn, and only the pages scrolled to are read. A row not read yet shows
 * as a placeholder. A change to an issue moves the rows it has, without reading the list again.
 */
export function createList(store: Store) {
  let filter: Filter = DEFAULT_FILTER;
  let keep = keeps(filter);
  let order = orderOf(filter);
  let view: View | undefined;
  let total: number | undefined;
  /** The rows read so far, by their place in the list. */
  let rows = new Map<number, Issue>();
  /** Pages read from `view`. A page read once is not read again, even if a row of it is missing. */
  let tried = new Set<number>();
  let wanted: number[] = [];
  let reading = false;
  /** `show` calls whose first rows are not drawn yet. */
  let loading = 0;
  let scrollTop = 0;
  let height = 0;
  let resets = 0;
  let snapshot: ListWindow = { count: 0, rows: [], none: false, top: 0 };
  const listeners = new Set<() => void>();

  function render() {
    const count = total ?? Math.max(-1, ...rows.keys()) + 1;
    const first = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN);
    const last = Math.min(count, Math.ceil((scrollTop + height) / ROW) + OVERSCAN);
    const missing = new Set<number>();
    const shown: { at: number; issue: Issue | undefined }[] = [];
    for (let at = first; at < last; at++) {
      const issue = rows.get(at);
      if (!issue) missing.add(Math.floor(at / PAGE));
      shown.push({ at, issue });
    }
    snapshot = { count, rows: shown, none: count === 0 && tried.has(0), top: resets };
    for (const listener of listeners) listener();
    wanted = [...missing].filter((page) => !tried.has(page));
    void pump();
  }

  /** Reads one page at a time, always one the list shows now: pages scrolled past are never read. */
  async function pump(): Promise<void> {
    const page = wanted[0];
    if (reading || page === undefined || !view) return;
    reading = true;
    const from = view;
    try {
      const docs = await from.read(page * PAGE, PAGE);
      if (from === view) {
        tried.add(page);
        docs.forEach((doc, i) => rows.set(page * PAGE + i, doc));
      }
    } finally {
      reading = false;
    }
    if (from === view) render();
    else void pump();
  }

  /** Takes `issue` out of the rows. Rows after it move up one place, whether or not its own row was read. */
  function remove(issue: Issue) {
    let at: number | undefined;
    for (const [i, row] of rows) if (row.id === issue.id) at = i;
    const next = new Map<number, Issue>();
    for (const [i, row] of rows) {
      if (i === at) continue;
      next.set((at === undefined ? order(row, issue) > 0 : i > at) ? i - 1 : i, row);
    }
    rows = next;
    total!--;
  }

  /** Puts `issue` among the rows. Rows after it move down one place; it gets a row if the rows around its place are read. */
  function insert(issue: Issue) {
    let slot: number | undefined;
    let before = -1;
    for (const [i, row] of rows) {
      if (order(row, issue) > 0) slot = slot === undefined ? i : Math.min(slot, i);
      else before = Math.max(before, i);
    }
    const at = slot ?? (before === total! - 1 ? total! : undefined);
    if (slot !== undefined) rows = new Map([...rows].map(([i, row]) => [i >= slot ? i + 1 : i, row]));
    if (at !== undefined && before === at - 1) rows.set(at, issue);
    total!++;
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => snapshot,

    /** The scroller moved or changed size. */
    scroll(top: number, size: number) {
      scrollTop = top;
      height = size;
      render();
    },

    /**
     * Reads the list under `next`, from its first row or, with `stay`, from the rows in view now. `rows` resolves with
     * how many rows the first page read has and when the store returned them; `total` with the list's size.
     */
    show(next: Filter, stay = false): { rows: Promise<{ rows: number; at: number }>; total: Promise<number> } {
      filter = next;
      keep = keeps(next);
      order = orderOf(next);
      const from = (view = viewOf(store, next));
      tried = new Set();
      const first = stay ? Math.floor(scrollTop / ROW / PAGE) : 0;
      const last = stay ? Math.floor((scrollTop + height) / ROW / PAGE) : 0;
      const pages = Array.from({ length: last - first + 1 }, (_, i) => first + i);
      const counted = from.total();
      loading++;
      const read = Promise.all(pages.map((page) => from.read(page * PAGE, PAGE))).then((docs) => {
        const at = performance.now();
        loading--;
        if (view !== from) return { rows: docs[0]!.length, at };
        rows = new Map(docs.flatMap((page, k) => page.map((doc, i): [number, Issue] => [(first + k) * PAGE + i, doc])));
        for (const page of pages) tried.add(page);
        if (!stay) {
          total = undefined;
          scrollTop = 0;
          resets++;
        }
        render();
        void counted.then((n) => {
          if (view !== from) return;
          total = n;
          render();
        });
        return { rows: docs[0]!.length, at };
      });
      return { rows: read, total: counted };
    },

    /**
     * Follows writes: each issue leaves the place it had and takes the one it has now, and the total moves with it.
     * Returns the new total, or undefined when the list has no total yet and must be read again.
     */
    apply(changes: readonly Change[]): number | undefined {
      if (total === undefined || loading > 0) return undefined;
      for (const { before, after } of changes) {
        if (before && keep(before)) remove(before);
        if (after && keep(after)) insert(after);
      }
      // Places moved, so cursors and counts of the view no longer fit: later pages come from a new one.
      view = viewOf(store, filter);
      tried = new Set();
      render();
      return total;
    },

    /** Adds issues the list has no row for and is not asked to place, as a bulk write does. Returns the new total. */
    grow(by: number): number | undefined {
      if (total !== undefined) total += by;
      snapshot = { ...snapshot, count: total ?? 0 };
      for (const listener of listeners) listener();
      return total;
    },

    /** The issue of a row read so far. */
    find(id: string): Issue | undefined {
      for (const row of rows.values()) if (row.id === id) return row;
      return undefined;
    },

    keeps: (issue: Issue) => keep(issue),
  };
}

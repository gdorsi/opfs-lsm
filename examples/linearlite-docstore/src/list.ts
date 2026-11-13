import { escape, priorityIcon, statusIcon } from "./icons.ts";
import { DEFAULT_FILTER, type Filter, type Issue } from "./model.ts";
import { keeps, orderOf, viewOf, type Store, type View } from "./store.ts";

const ROW = 40;
const PAGE = 50;
const OVERSCAN = 8;

const sameYear = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });
const otherYear = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" });
const thisYear = new Date().getFullYear();
export const shortDate = (ms: number) => {
  const d = new Date(ms);
  return (d.getFullYear() === thisYear ? sameYear : otherYear).format(d);
};
export const shortId = (id: string) => `LL-${id.slice(0, 5).toUpperCase()}`;

const rowOf = (i: Issue, at: number) =>
  `<div class="row" data-at="${at}" style="transform:translateY(${at * ROW}px)"><span class="icon-btn">${priorityIcon(i.priority)}</span>` +
  `<span class="id">${shortId(i.id)}</span>${statusIcon(i.status)}<span class="name">${escape(i.title)}</span>` +
  `<span class="avatar" title="${escape(i.username)}">${escape(i.username.slice(0, 1))}</span><span class="date">${shortDate(i.modified)}</span></div>`;

const skeleton = (at: number) =>
  `<div class="skel" style="transform:translateY(${at * ROW}px)"><i style="width:14px"></i><i style="width:48px"></i><i style="width:${30 + ((at * 37) % 40)}%"></i></div>`;

/** One issue of a write: as the list held it before, and as it is stored now. Absent on a side where it does not exist. */
export type Change = { readonly before: Issue | undefined; readonly after: Issue | undefined };

/**
 * The issue list: only the rows in view are in the document, and only the pages scrolled to are read. A row not read
 * yet shows as a placeholder. A change to an issue moves the rows it has, without reading the list again.
 */
export function createList(scroller: HTMLElement, store: Store, open: (issue: Issue) => void) {
  const rowsEl = scroller.querySelector<HTMLElement>(".rows")!;
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
  let frame = 0;
  /** `show` calls whose first rows are not in the document yet. */
  let loading = 0;

  function render() {
    const count = total ?? Math.max(-1, ...rows.keys()) + 1;
    rowsEl.style.height = `${count * ROW}px`;
    if (count === 0) {
      rowsEl.innerHTML = tried.has(0) ? `<div class="none">No issues match</div>` : "";
      return;
    }
    const first = Math.max(0, Math.floor(scroller.scrollTop / ROW) - OVERSCAN);
    const last = Math.min(count, Math.ceil((scroller.scrollTop + scroller.clientHeight) / ROW) + OVERSCAN);
    const missing = new Set<number>();
    let html = "";
    for (let at = first; at < last; at++) {
      const issue = rows.get(at);
      if (!issue) missing.add(Math.floor(at / PAGE));
      html += issue ? rowOf(issue, at) : skeleton(at);
    }
    rowsEl.innerHTML = html;
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

  scroller.addEventListener(
    "scroll",
    () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(render);
    },
    { passive: true },
  );
  new ResizeObserver(render).observe(scroller);
  rowsEl.addEventListener("click", (e) => {
    const at = (e.target as Element).closest<HTMLElement>(".row")?.dataset.at;
    const issue = at === undefined ? undefined : rows.get(Number(at));
    if (issue) open(issue);
  });

  return {
    /**
     * Reads the list under `next`, from its first row or, with `stay`, from the rows in view now. `rows` resolves with
     * how many rows of the first page read exist, once they are in the document; `total` with the list's size.
     */
    show(next: Filter, stay = false): { rows: Promise<number>; total: Promise<number> } {
      filter = next;
      keep = keeps(next);
      order = orderOf(next);
      const from = (view = viewOf(store, next));
      tried = new Set();
      const first = stay ? Math.floor(scroller.scrollTop / ROW / PAGE) : 0;
      const last = stay ? Math.floor((scroller.scrollTop + scroller.clientHeight) / ROW / PAGE) : 0;
      const pages = Array.from({ length: last - first + 1 }, (_, i) => first + i);
      const counted = from.total();
      loading++;
      const read = Promise.all(pages.map((page) => from.read(page * PAGE, PAGE))).then((docs) => {
        loading--;
        if (view !== from) return docs[0]!.length;
        rows = new Map(docs.flatMap((page, k) => page.map((doc, i): [number, Issue] => [(first + k) * PAGE + i, doc])));
        for (const page of pages) tried.add(page);
        if (!stay) {
          total = undefined;
          scroller.scrollTop = 0;
        }
        render();
        void counted.then((n) => {
          if (view !== from) return;
          total = n;
          render();
        });
        return docs[0]!.length;
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
      rowsEl.style.height = `${(total ?? 0) * ROW}px`;
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

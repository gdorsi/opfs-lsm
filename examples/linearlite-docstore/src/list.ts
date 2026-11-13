import { escape, priorityIcon, statusIcon } from "./icons.ts";
import type { Issue } from "./model.ts";
import type { View } from "./store.ts";

const ROW = 40;
const PAGE = 50;
const OVERSCAN = 8;

const sameYear = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });
const otherYear = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" });
const thisYear = new Date().getFullYear();
const date = (ms: number) => {
  const d = new Date(ms);
  return (d.getFullYear() === thisYear ? sameYear : otherYear).format(d);
};

const rowOf = (i: Issue, at: number) =>
  `<div class="row" style="transform:translateY(${at * ROW}px)"><span class="icon-btn" title="Priority">${priorityIcon(i.priority)}</span>` +
  `<span class="id">LL-${i.id.slice(0, 5).toUpperCase()}</span>${statusIcon(i.status)}<span class="name">${escape(i.title)}</span>` +
  `<span class="avatar" title="${escape(i.username)}">${escape(i.username.slice(0, 1))}</span><span class="date">${date(i.modified)}</span></div>`;

const skeleton = (at: number) =>
  `<div class="skel" style="transform:translateY(${at * ROW}px)"><i style="width:14px"></i><i style="width:48px"></i><i style="width:${30 + ((at * 37) % 40)}%"></i></div>`;

/**
 * The issue list: only the rows in view are in the document, and only the pages scrolled to are read. A row not read
 * yet shows as a placeholder.
 */
export function createList(scroller: HTMLElement) {
  const rowsEl = scroller.querySelector<HTMLElement>(".rows")!;
  let view: View | undefined;
  let total: number | undefined;
  let rows = new Map<number, Issue>();
  let loaded = new Set<number>();
  let wanted: number[] = [];
  let reading = false;
  let frame = 0;

  function render() {
    const count = total ?? rows.size;
    rowsEl.style.height = `${count * ROW}px`;
    if (count === 0) {
      rowsEl.innerHTML = loaded.has(0) ? `<div class="none">No issues match</div>` : "";
      return;
    }
    const first = Math.max(0, Math.floor(scroller.scrollTop / ROW) - OVERSCAN);
    const last = Math.min(count, Math.ceil((scroller.scrollTop + scroller.clientHeight) / ROW) + OVERSCAN);
    let html = "";
    for (let at = first; at < last; at++) {
      const issue = rows.get(at);
      html += issue ? rowOf(issue, at) : skeleton(at);
    }
    rowsEl.innerHTML = html;
    wanted = [];
    for (let page = Math.floor(first / PAGE); page * PAGE < last; page++) if (!loaded.has(page)) wanted.push(page);
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
        loaded.add(page);
        docs.forEach((doc, i) => rows.set(page * PAGE + i, doc));
      }
    } finally {
      reading = false;
    }
    if (from === view) render();
    else void pump();
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

  return {
    /** Shows `next` from its first row. Resolves with the rows of the first page, once they are in the document. */
    async show(next: View): Promise<number> {
      view = next;
      const first = await next.read(0, PAGE);
      if (view !== next) return first.length;
      total = undefined;
      rows = new Map(first.map((doc, i) => [i, doc]));
      loaded = new Set([0]);
      scroller.scrollTop = 0;
      render();
      void next.total.then((n) => {
        if (view !== next) return;
        total = n;
        render();
      });
      return first.length;
    },
  };
}

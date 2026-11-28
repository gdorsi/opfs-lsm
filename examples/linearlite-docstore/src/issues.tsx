import { useLiveQuery } from "@opfs-lsm/db/solid";
import { createEffect, createMemo, createSignal, For, Loading, onSettled, Repeat, Show } from "solid-js";
import type { App } from "./app.ts";
import { PriorityIcon, StatusIcon } from "./icons.tsx";
import { PAGE } from "./list.ts";
import { codeItems, MenuButton } from "./menu.tsx";
import type { Issue } from "./model.ts";

const ROW = 40;
const OVERSCAN = 8;

const sameYear = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });
const otherYear = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" });
const thisYear = new Date().getFullYear();
export const shortDate = (ms: number) => {
  const d = new Date(ms);
  return (d.getFullYear() === thisYear ? sameYear : otherYear).format(d);
};
export const shortId = (id: string) => `LL-${id.slice(0, 5).toUpperCase()}`;

/**
 * The issue list. Its height is the list's total. It draws the places in view and a few around them, and reads only
 * the pages they fall in: each page is a live query of its own, drawn as placeholders until its rows are read.
 * `hidden` takes the list off the page and keeps its queries.
 */
export function IssueList(props: { app: App; total: number; hidden: boolean }) {
  let scroller!: HTMLDivElement;
  // A list under a new filter starts at its first row.
  const [top, setTop] = createSignal(() => (props.app.filter(), 0));
  const [height, setHeight] = createSignal(0);
  const first = createMemo(() => Math.max(0, Math.floor(top() / ROW) - OVERSCAN));
  const end = createMemo(() => Math.ceil((top() + height()) / ROW) + OVERSCAN);
  const pages = createMemo(
    () => {
      const from = Math.floor(first() / PAGE);
      return Array.from({ length: Math.ceil(end() / PAGE) - from }, (_, i) => from + i);
    },
    { equals: (a, b) => a.length === b.length && a[0] === b[0] },
  );

  onSettled(() => {
    let frame = 0;
    const report = () => {
      setTop(scroller.scrollTop);
      setHeight(scroller.clientHeight);
    };
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(report);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    const resize = new ResizeObserver(report);
    resize.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      resize.disconnect();
      cancelAnimationFrame(frame);
    };
  });

  createEffect(
    () => props.app.filter(),
    () => {
      scroller.scrollTop = 0;
    },
    { defer: true },
  );

  return (
    <div class="scroller" id="scroller" hidden={props.hidden} ref={(el) => (scroller = el)}>
      <div class="rows" style={{ height: `${props.total * ROW}px` }}>
        <Show when={props.total === 0}>
          <div class="none">No issues match</div>
        </Show>
        <For each={pages()}>
          {(page) => {
            // The part of this page among the places drawn.
            const from = () => Math.max(0, first() - page * PAGE);
            const to = () => Math.min(PAGE, end() - page * PAGE);
            return (
              <Loading
                fallback={
                  <Repeat from={from()} count={Math.max(0, Math.min(to(), props.total - page * PAGE) - from())}>
                    {(i) => <Skeleton at={page * PAGE + i} />}
                  </Repeat>
                }
              >
                <Page app={props.app} at={page} from={from()} to={to()} />
              </Loading>
            );
          }}
        </For>
      </div>
    </div>
  );
}

/** Rows `from` to `to` of page `at`, as many as the page holds. A row keeps its elements while the issue at its place changes. */
function Page(props: { app: App; at: number; from: number; to: number }) {
  const rows = useLiveQuery(() => props.app.page(props.at));
  return (
    <Repeat from={props.from} count={Math.max(0, Math.min(props.to, rows().length) - props.from)}>
      {(i) => <Row at={props.at * PAGE + i} issue={rows()[i]!} app={props.app} />}
    </Repeat>
  );
}

function Row(props: { at: number; issue: Issue; app: App }) {
  // The priority and status icons change the issue in place, as in LinearLite; the rest of the row opens it.
  const pick = (field: "status" | "priority") =>
    codeItems(field, (c) => props.issue[field] === c, (c) => props.app.edit(props.issue.id, { [field]: c }));
  return (
    <div class="row" style={{ transform: `translateY(${props.at * ROW}px)` }} onClick={() => props.app.open(props.issue.id)}>
      <MenuButton class="icon-btn" title="Priority" items={pick("priority")}>
        <PriorityIcon code={props.issue.priority} />
      </MenuButton>
      <span class="id">{shortId(props.issue.id)}</span>
      <MenuButton class="icon-btn" title="Status" items={pick("status")}>
        <StatusIcon code={props.issue.status} />
      </MenuButton>
      <span class="name">{props.issue.title}</span>
      <span class="avatar" title={props.issue.username}>
        {props.issue.username.slice(0, 1)}
      </span>
      <span class="date">{shortDate(props.issue.modified)}</span>
    </div>
  );
}

const Skeleton = (props: { at: number }) => (
  <div class="skel" style={{ transform: `translateY(${props.at * ROW}px)` }}>
    <i style={{ width: "14px" }} />
    <i style={{ width: "48px" }} />
    <i style={{ width: `${30 + ((props.at * 37) % 40)}%` }} />
  </div>
);

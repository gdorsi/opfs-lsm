import { createEffect, createMemo, For, from, onSettled, Show } from "solid-js";
import type { App } from "./app.ts";
import { PriorityIcon, StatusIcon } from "./icons.tsx";
import { ROW } from "./list.ts";
import { codeItems, MenuButton } from "./menu.tsx";
import type { Issue } from "./model.ts";

const sameYear = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });
const otherYear = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" });
const thisYear = new Date().getFullYear();
export const shortDate = (ms: number) => {
  const d = new Date(ms);
  return (d.getFullYear() === thisYear ? sameYear : otherYear).format(d);
};
export const shortId = (id: string) => `LL-${id.slice(0, 5).toUpperCase()}`;

/** The rows in view of the list model: a row per read issue, a placeholder per place whose page is not read yet. */
export function IssueList(props: { app: App }) {
  const win = createMemo(() => from(props.app.list.subscribe));
  const top = createMemo(() => win().top);
  let scroller!: HTMLDivElement;

  onSettled(() => {
    const { list } = props.app;
    let frame = 0;
    const report = () => list.scroll(scroller.scrollTop, scroller.clientHeight);
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

  // A list read from its first row starts at the top.
  createEffect(top, () => {
    scroller.scrollTop = 0;
  });

  return (
    <div class="scroller" id="scroller" ref={(el) => (scroller = el)}>
      <div class="rows" style={{ height: `${win().count * ROW}px` }}>
        <Show when={win().none}>
          <div class="none">No issues match</div>
        </Show>
        <For each={win().rows} keyed={(row) => row.at}>
          {(row) => (
            <Show when={row().issue} fallback={<Skeleton at={row().at} />}>
              {(issue) => <Row at={row().at} issue={issue()} app={props.app} />}
            </Show>
          )}
        </For>
      </div>
    </div>
  );
}

function Row(props: { at: number; issue: Issue; app: App }) {
  // The priority and status icons change the issue in place, as in LinearLite; the rest of the row opens it.
  const pick = (field: "status" | "priority") =>
    codeItems(field, (c) => props.issue[field] === c, (c) => props.app.edit(props.issue.id, { [field]: c }));
  return (
    <div class="row" style={{ transform: `translateY(${props.at * ROW}px)` }} onClick={() => props.app.open(props.issue)}>
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

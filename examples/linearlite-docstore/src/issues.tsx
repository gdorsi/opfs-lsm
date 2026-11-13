import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
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
export function IssueList({ app }: { app: App }) {
  const { list } = app;
  const win = useSyncExternalStore(list.subscribe, list.snapshot);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scroller.current!;
    let frame = 0;
    const report = () => list.scroll(el.scrollTop, el.clientHeight);
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(report);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const resize = new ResizeObserver(report);
    resize.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      resize.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [list]);

  // A list read from its first row starts at the top.
  useLayoutEffect(() => {
    scroller.current!.scrollTop = 0;
  }, [win.top]);

  return (
    <div className="scroller" id="scroller" ref={scroller}>
      <div className="rows" style={{ height: win.count * ROW }}>
        {win.none && <div className="none">No issues match</div>}
        {win.rows.map(({ at, issue }) => (issue ? <Row key={at} at={at} issue={issue} app={app} /> : <Skeleton key={at} at={at} />))}
      </div>
    </div>
  );
}

function Row({ at, issue, app }: { at: number; issue: Issue; app: App }) {
  // The priority and status icons change the issue in place, as in LinearLite; the rest of the row opens it.
  const pick = (field: "status" | "priority") => codeItems(field, (c) => issue[field] === c, (c) => app.edit(issue.id, { [field]: c }));
  return (
    <div className="row" style={{ transform: `translateY(${at * ROW}px)` }} onClick={() => app.open(issue)}>
      <MenuButton className="icon-btn" title="Priority" items={pick("priority")}>
        <PriorityIcon code={issue.priority} />
      </MenuButton>
      <span className="id">{shortId(issue.id)}</span>
      <MenuButton className="icon-btn" title="Status" items={pick("status")}>
        <StatusIcon code={issue.status} />
      </MenuButton>
      <span className="name">{issue.title}</span>
      <span className="avatar" title={issue.username}>
        {issue.username.slice(0, 1)}
      </span>
      <span className="date">{shortDate(issue.modified)}</span>
    </div>
  );
}

const Skeleton = ({ at }: { at: number }) => (
  <div className="skel" style={{ transform: `translateY(${at * ROW}px)` }}>
    <i style={{ width: 14 }} />
    <i style={{ width: 48 }} />
    <i style={{ width: `${30 + ((at * 37) % 40)}%` }} />
  </div>
);

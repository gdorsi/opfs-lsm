import { useNavigate } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import * as commands from "../client/commands.ts";
import type { IssueFilter } from "../client/filter.ts";
import { useIssueWindow } from "../client/hooks.ts";
import type { Issue } from "../domain/model.ts";
import { formatDate, initial, shortId } from "./format.ts";
import { isTyping, keepSearch, useCreateModal, useIssueFilter, useKeys, useSetFilter } from "./nav.ts";
import { PriorityPicker, StatusPicker } from "./pickers.tsx";
import { Toolbar } from "./toolbar.tsx";

const ROW = 40;
const OVERSCAN = 12;
const WINDOW = 100;
const LEAD = 30;

/**
 * Scroll offset per filter, so Back from an issue lands where the user left. The router's own scroll restoration is
 * off: it puts a stale offset onto the fresh scroller of a new filter.
 */
const scrolled = new Map<string, number>();

export function ListScreen() {
  const filter = useIssueFilter();
  const view = useIssueWindow(filter);
  const filterKey = JSON.stringify(filter);
  useEffect(() => {
    if (view.rows.length > 0 && performance.getEntriesByName("linearlite:first-rows").length === 0) performance.mark("linearlite:first-rows");
  }, [view.rows.length]);
  return (
    <>
      <Toolbar title="All issues" count={view.total} filter={filter} />
      {view.total === 0 ? <ListEmpty filter={filter} /> : <VirtualList key={filterKey} filterKey={filterKey} {...view} />}
    </>
  );
}

function ListEmpty({ filter }: { filter: IssueFilter }) {
  const setFilter = useSetFilter();
  const { open } = useCreateModal();
  const filtered = filter.status.length > 0 || filter.priority.length > 0 || filter.q !== "";
  return (
    <div className="empty">
      <div>
        {filtered ? (
          <>
            <h2>No issues match</h2>
            <p>Nothing fits these filters.</p>
            <button className="btn" onClick={() => setFilter({ status: [], priority: [], q: "" })}>
              Clear filters
            </button>
          </>
        ) : (
          <>
            <h2>No issues yet</h2>
            <p>Create one, or wait for the first sync to bring them in.</p>
            <button className="btn primary" onClick={open}>
              New issue
            </button>
          </>
        )}
      </div>
    </div>
  );
}

interface ListProps {
  readonly filterKey: string;
  readonly rows: readonly Issue[];
  readonly offset: number;
  readonly total: number;
  setRange(start: number, end: number): void;
}

function VirtualList({ filterKey: key, rows, offset, total, setRange }: ListProps) {
  const navigate = useNavigate();
  const scroller = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState<number | null>(null);

  const virtual = useVirtualizer({
    count: total,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW,
    overscan: OVERSCAN,
  });
  const items = virtual.getVirtualItems();
  const first = items[0]?.index ?? 0;
  const last = items.at(-1)?.index ?? 0;

  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scrolled.get(key) ?? 0;
  }, [key]);

  useEffect(() => {
    if (items.length === 0) return;
    const loaded = first >= offset && last < offset + rows.length;
    if (!loaded) setRange(Math.max(0, first - LEAD), Math.max(0, first - LEAD) + WINDOW);
  }, [first, last, offset, rows.length, items.length, setRange]);

  const open = (issue: Issue) => void navigate({ to: "/issue/$id", params: { id: issue.id }, search: keepSearch });

  useKeys((e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
    if (e.key === "j" || e.key === "k") {
      e.preventDefault();
      const from = focus ?? first - (e.key === "j" ? 1 : -1);
      const next = Math.max(0, Math.min(total - 1, from + (e.key === "j" ? 1 : -1)));
      setFocus(next);
      virtual.scrollToIndex(next, { align: "auto" });
    } else if (e.key === "Enter" && focus !== null && !(e.target as HTMLElement).closest("button, a, [role=menu]")) {
      const issue = rows[focus - offset];
      if (issue) open(issue);
    }
  });

  return (
    <div ref={scroller} className="scroller" id="scroller" onScroll={(e) => scrolled.set(key, e.currentTarget.scrollTop)}>
      <div className="rows" style={{ height: virtual.getTotalSize() }}>
        {items.map((v) => {
          const issue = v.index >= offset ? rows[v.index - offset] : undefined;
          return issue ? (
            <Row key={issue.id} issue={issue} index={v.index} focused={v.index === focus} top={v.start} onOpen={open} />
          ) : (
            <SkeletonRow key={`s${v.index}`} index={v.index} top={v.start} />
          );
        })}
      </div>
    </div>
  );
}

function Row({ issue, index, focused, top, onOpen }: { issue: Issue; index: number; focused: boolean; top: number; onOpen(i: Issue): void }) {
  return (
    <div
      className={`row${focused ? " focus" : ""}`}
      style={{ transform: `translateY(${top}px)` }}
      data-index={index}
      data-id={issue.id}
      data-status={issue.status}
      data-priority={issue.priority}
      id={`issue-${issue.id}`}
      onClick={() => onOpen(issue)}
    >
      <PriorityPicker variant="icon" value={issue.priority} onPick={(p) => void commands.setPriority(issue.id, p)} />
      <span className="id">{shortId(issue.id)}</span>
      <StatusPicker variant="icon" value={issue.status} onPick={(s) => void commands.setStatus(issue.id, s)} />
      <span className="name">{issue.title}</span>
      {issue.dirty ? <span className="dot" title="Not synced yet" data-dirty /> : <span className="dot-slot" />}
      <span className="avatar" title={issue.username}>
        {initial(issue.username)}
      </span>
      <span className="date">{formatDate(issue.modified)}</span>
    </div>
  );
}

function SkeletonRow({ index, top }: { index: number; top: number }) {
  const width = 30 + ((index * 37) % 40);
  return (
    <div className="skel" style={{ transform: `translateY(${top}px)` }} data-skeleton data-index={index}>
      <i style={{ width: 24 }} />
      <i style={{ width: 52 }} />
      <i style={{ width: 14 }} />
      <i style={{ width: `${width}%` }} />
    </div>
  );
}

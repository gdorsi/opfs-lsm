import { useNavigate } from "@tanstack/react-router";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFateClient, useListView, useRefetch, useRequest, useView, view, type ViewRef } from "react-fate";
import { filterArgs, windowArgs } from "../client/args.ts";
import * as commands from "../client/commands.ts";
import { CACHE_ONLY, REQUEST } from "../client/fate.ts";
import type { IssueFilter } from "../client/filter.ts";
import { usePending, useRefetchOnDelivery } from "../client/hooks.ts";
import { totalOf, type IssueEntity } from "../domain/model.ts";
import { formatDate, initial, shortId } from "./format.ts";
import { isTyping, keepSearch, useCreateModal, useIssueFilter, useKeys, useSetFilter } from "./nav.ts";
import { PriorityPicker, StatusPicker } from "./pickers.tsx";
import { Toolbar } from "./toolbar.tsx";

const ROW = 40;
const OVERSCAN = 12;

const RowView = view<IssueEntity>()({ id: true, title: true, status: true, priority: true, username: true, modified: true });
/** A list window is complete as fetched: it never pages. */
const WindowView = { items: { node: RowView } } as const;

/** One window of the filtered, sorted list; also what a new issue is inserted into when the list is newest first. */
export const windowRequest = (filter: IssueFilter, row: number) => ({ issues: { args: windowArgs(filter, row), list: WindowView } });
const countsRequest = (filter: IssueFilter) => ({ counts: { args: filterArgs(filter), value: true as const } });

/**
 * Scroll offset per filter, so Back from an issue lands where the user left. The router's own scroll restoration is
 * off: it puts a stale offset onto the fresh scroller of a new filter.
 */
const scrolled = new Map<string, number>();

export function ListScreen() {
  const live = useIssueFilter();
  // A new filter or sort keeps the current list on screen until its counts arrive.
  const filter = useDeferredValue(live);
  const request = useMemo(() => countsRequest(filter), [filter]);
  const { counts } = useRequest(request, REQUEST);
  useRefetchOnDelivery(request);
  const total = totalOf(counts);
  const filterKey = JSON.stringify(filter);
  return (
    <>
      <Toolbar title="All issues" count={total} filter={live} />
      {total === 0 ? <ListEmpty filter={filter} /> : <VirtualList key={filterKey} filterKey={filterKey} filter={filter} total={total} />}
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
            <p>Create one to get started.</p>
            <button className="btn primary" onClick={open}>
              New issue
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function VirtualList({ filterKey: key, filter, total }: { filterKey: string; filter: IssueFilter; total: number }) {
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

  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scrolled.get(key) ?? 0;
  }, [key]);

  const open = (id: string) => void navigate({ to: "/issue/$id", params: { id }, search: keepSearch });

  useKeys((e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
    if (e.key === "j" || e.key === "k") {
      e.preventDefault();
      const from = focus ?? first - (e.key === "j" ? 1 : -1);
      const next = Math.max(0, Math.min(total - 1, from + (e.key === "j" ? 1 : -1)));
      setFocus(next);
      virtual.scrollToIndex(next, { align: "auto" });
    } else if (e.key === "Enter" && focus !== null && !(e.target as HTMLElement).closest("button, a, [role=menu]")) {
      const id = scroller.current?.querySelector<HTMLElement>(`.row[data-index="${focus}"]`)?.dataset.id;
      if (id) open(id);
    }
  });

  // The visible rows, by the window that holds them.
  const windows = new Map<number, VirtualItem[]>();
  for (const v of items) {
    const offset = windowArgs(filter, v.index).offset;
    windows.set(offset, [...(windows.get(offset) ?? []), v]);
  }

  return (
    <div ref={scroller} className="scroller" id="scroller" onScroll={(e) => scrolled.set(key, e.currentTarget.scrollTop)}>
      <div className="rows" style={{ height: virtual.getTotalSize() }}>
        {[...windows].map(([offset, rows]) => (
          <Window key={offset} filter={filter} offset={offset} rows={rows} focus={focus} onOpen={open} />
        ))}
      </div>
    </div>
  );
}

/**
 * One window's rows: what the device holds, refreshed from the server on mount. Rows the window lacks are skeletons,
 * also when the fetch fails, so a window the user visited paints with the server unreachable. It reads `cache-only`
 * because fate's `stale-while-revalidate` does not count a positional window as cached and waits for the server.
 */
function Window({ filter, offset, rows, focus, onOpen }: { filter: IssueFilter; offset: number; rows: readonly VirtualItem[]; focus: number | null; onOpen(id: string): void }) {
  const request = useMemo(() => windowRequest(filter, offset), [filter, offset]);
  const cached = useRequest(request, CACHE_ONLY);
  const refetch = useRefetch(request, { persist: REQUEST.persist });
  useEffect(() => {
    refetch().catch((err: unknown) => console.warn("linearlite could not load a list window", err));
  }, [refetch]);
  useRefetchOnDelivery(request);
  const [items = []] = useListView(WindowView, cached?.issues);
  useEffect(() => {
    if (items.length > 0 && performance.getEntriesByName("linearlite:first-rows").length === 0) performance.mark("linearlite:first-rows");
  }, [items.length]);
  return rows.map((v) => {
    const node = items[v.index - offset]?.node;
    return node ? (
      <Row key={node.id} issue={node} index={v.index} focused={v.index === focus} top={v.start} onOpen={onOpen} />
    ) : (
      <SkeletonRow key={`s${v.index}`} index={v.index} top={v.start} />
    );
  });
}

function Row({ issue: ref, index, focused, top, onOpen }: { issue: ViewRef<"Issue">; index: number; focused: boolean; top: number; onOpen(id: string): void }) {
  const fate = useFateClient();
  const issue = useView(RowView, ref);
  const pending = usePending(issue.id);
  return (
    <div
      className={`row${focused ? " focus" : ""}`}
      style={{ transform: `translateY(${top}px)` }}
      data-index={index}
      data-id={issue.id}
      data-status={issue.status}
      data-priority={issue.priority}
      id={`issue-${issue.id}`}
      onClick={() => onOpen(issue.id)}
    >
      <PriorityPicker variant="icon" value={issue.priority} onPick={(p) => void commands.setPriority(fate, issue.id, p)} />
      <span className="id">{shortId(issue.id)}</span>
      <StatusPicker variant="icon" value={issue.status} onPick={(s) => void commands.setStatus(fate, issue.id, s)} />
      <span className="name">{issue.title}</span>
      {pending ? <span className="dot" title="Not synced yet" data-dirty /> : <span className="dot-slot" />}
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


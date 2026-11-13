import { useNavigate } from "@tanstack/react-router";
import { useDeferredValue, useMemo, useRef, useState, type DragEvent } from "react";
import { alias, useFateClient, useListView, useRequest, useView, useViews, view, type InsertionTarget, type ViewRef } from "react-fate";
import { columnArgs, filterArgs } from "../client/args.ts";
import * as commands from "../client/commands.ts";
import { REQUEST } from "../client/fate.ts";
import type { IssueFilter } from "../client/filter.ts";
import { usePending, useRefetchOnDelivery } from "../client/hooks.ts";
import { byKanbanOrder } from "../domain/kanban.ts";
import { CODES, STATUS_LABELS, totalOf, type IssueEntity, type StatusCode, type StatusCounts } from "../domain/model.ts";
import { shortId } from "./format.ts";
import { PriorityIcon, StatusIcon } from "./icons.tsx";
import { keepSearch, useIssueFilter } from "./nav.ts";
import { Toolbar } from "./toolbar.tsx";

const COLUMN_PAGE = 50;
const NEAR_BOTTOM = 400;

/** What a column sorts its cards by; the server orders a column the same way. */
export const OrderView = view<IssueEntity>()({ id: true, kanbanorder: true });
const CardView = view<IssueEntity>()({ id: true, title: true, priority: true });
/** A column's cards carry both views: the column sorts by one, each card renders the other. */
export const ColumnView = { items: { node: view<IssueEntity>()({ id: true, ...OrderView, ...CardView }) }, pagination: { hasNext: true, nextCursor: true } } as const;

/** A column, as `useListView` reads it and as a mutation names it to insert into or remove from. */
export type ColumnConnection = InsertionTarget<"Issue"> & Parameters<typeof useListView>[1];
export type BoardResult = { readonly counts: StatusCounts } & Partial<Record<`c${StatusCode}`, ColumnConnection>>;

/** The board's counts and its columns in one request, so the columns load together. A filtered-out status has no column. */
export function boardRequest(filter: IssueFilter) {
  const columns = CODES.flatMap((s) => {
    const args = columnArgs(s, filter, COLUMN_PAGE);
    return args ? [[`c${s}`, alias("column", { args, list: ColumnView })] as const] : [];
  });
  return { counts: { args: filterArgs(filter), value: true as const }, ...Object.fromEntries(columns) };
}

type Dragging = { readonly card: ViewRef<"Issue">; readonly from: StatusCode };

export function BoardScreen() {
  const live = useIssueFilter();
  // A new filter keeps the current board on screen until its columns arrive.
  const filter = useDeferredValue(live);
  const fate = useFateClient();
  const request = useMemo(() => boardRequest(filter), [filter]);
  const board = useRequest(request, REQUEST) as BoardResult;
  useRefetchOnDelivery(request);
  const [dragging, setDragging] = useState<Dragging | null>(null);

  const move = (to: StatusCode, before: string | null, after: string | null) => {
    if (!dragging) return;
    const { card, from } = dragging;
    setDragging(null);
    const other = from !== to;
    void commands.moveIssue(fate, card, { status: to, before, after, from: other ? board[`c${from}`] : undefined, to: other ? board[`c${to}`] : undefined });
  };

  return (
    <>
      <Toolbar title="Board" count={totalOf(board.counts)} filter={live} />
      <div className="board">
        {CODES.map((status) => (
          <Column
            key={status}
            status={status}
            count={board.counts[status]}
            connection={board[`c${status}`]}
            dragging={dragging ? String(dragging.card.id) : null}
            onDrag={(card) => setDragging(card && { card, from: status })}
            onDrop={(before, after) => move(status, before, after)}
          />
        ))}
      </div>
    </>
  );
}

interface ColumnProps {
  readonly status: StatusCode;
  readonly count: number;
  readonly connection: ColumnConnection | undefined;
  readonly dragging: string | null;
  onDrag(card: ViewRef<"Issue"> | null): void;
  onDrop(before: string | null, after: string | null): void;
}

/**
 * One board column by `kanbanorder`, growing a page at a time. The cards are sorted here too, so a card moved within
 * or into the column takes its place at once.
 */
function Column({ status, count, connection, dragging, onDrag, onDrop }: ColumnProps) {
  const navigate = useNavigate();
  const [items = [], loadNext] = useListView(ColumnView, connection);
  const refs = useMemo(() => items.map((item) => item.node), [items]);
  const orders = useViews(OrderView, refs);
  const cards = useMemo(() => refs.map((ref, i) => ({ ref, order: orders[i]! })).toSorted((a, b) => byKanbanOrder(a.order, b.order)), [refs, orders]);
  const body = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<number | null>(null);
  const loading = useRef(false);

  const others = cards.filter((c) => c.ref.id !== dragging);

  const indexAt = (e: DragEvent) => {
    const els = [...(body.current?.querySelectorAll<HTMLElement>("[data-card]") ?? [])].filter((c) => c.dataset.card !== dragging);
    const i = els.findIndex((c) => {
      const r = c.getBoundingClientRect();
      return e.clientY < r.top + r.height / 2;
    });
    return i === -1 ? els.length : i;
  };

  const loadMore = () => {
    if (!loadNext || loading.current) return;
    loading.current = true;
    loadNext()
      .catch((err: unknown) => console.warn("linearlite could not load more of a column", err))
      .finally(() => (loading.current = false));
  };

  let seen = 0;
  return (
    <section
      className={`col${at !== null ? " over" : ""}`}
      data-status={status}
      onDragOver={(e) => {
        if (!dragging) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setAt(indexAt(e));
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setAt(null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        const index = indexAt(e);
        setAt(null);
        onDrop(others[index - 1]?.order.kanbanorder ?? null, others[index]?.order.kanbanorder ?? null);
      }}
    >
      <header className="col-head">
        <StatusIcon status={status} />
        {STATUS_LABELS[status]}
        <span className="count mono" data-count>
          {count.toLocaleString()}
        </span>
      </header>
      <div
        ref={body}
        className="cards"
        onScroll={(e) => {
          const el = e.currentTarget;
          if (cards.length < count && el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM) loadMore();
        }}
      >
        {count === 0 && <div className="col-empty">No issues</div>}
        {cards.map(({ ref }) => {
          const mine = ref.id === dragging;
          const line = !mine && at === seen++;
          return (
            <div key={ref.id}>
              {line && <div className="drop-line" data-drop />}
              <Card issue={ref} dragging={mine} onOpen={() => void navigate({ to: "/issue/$id", params: { id: ref.id }, search: keepSearch })} onDrag={onDrag} />
            </div>
          );
        })}
        {at !== null && at >= others.length && <div className="drop-line" data-drop />}
      </div>
    </section>
  );
}

function Card({ issue: ref, dragging, onOpen, onDrag }: { issue: ViewRef<"Issue">; dragging: boolean; onOpen(): void; onDrag(card: ViewRef<"Issue"> | null): void }) {
  const issue = useView(CardView, ref);
  const pending = usePending(issue.id);
  return (
    <article
      className={`card${dragging ? " dragging" : ""}`}
      data-card={issue.id}
      draggable
      onClick={onOpen}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", issue.id);
        e.dataTransfer.effectAllowed = "move";
        onDrag(ref);
      }}
      onDragEnd={() => onDrag(null)}
    >
      <div className="card-top">
        <PriorityIcon priority={issue.priority} />
        <span>{shortId(issue.id)}</span>
        {pending && <span className="dot" title="Not synced yet" data-dirty />}
      </div>
      <div className="card-title">{issue.title}</div>
    </article>
  );
}

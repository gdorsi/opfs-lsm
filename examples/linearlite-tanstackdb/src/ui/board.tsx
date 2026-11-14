import { useNavigate } from "@tanstack/react-router";
import { useRef, useState, type DragEvent } from "react";
import * as commands from "../client/commands.ts";
import type { IssueFilter } from "../client/filter.ts";
import { useBoardColumn, usePreloadDetails, useStatusCounts } from "../client/hooks.ts";
import { STATUS_LABELS, type Issue, type StatusCode } from "../domain/model.ts";
import { shortId } from "./format.ts";
import { PriorityIcon, StatusIcon } from "./icons.tsx";
import { keepSearch, useIssueFilter } from "./nav.ts";
import { Toolbar } from "./toolbar.tsx";

const COLUMNS = [0, 1, 2, 3, 4] as const;
const GROW = 50;
const NEAR_BOTTOM = 400;

export function BoardScreen() {
  const filter = useIssueFilter();
  const counts = useStatusCounts(filter);
  const [dragging, setDragging] = useState<string | null>(null);
  return (
    <>
      <Toolbar title="Board" count={counts?.reduce((a, b) => a + b, 0)} filter={filter} />
      <div className="board">
        {COLUMNS.map((status) => (
          <Column key={status} status={status} count={counts?.[status]} filter={filter} dragging={dragging} setDragging={setDragging} />
        ))}
      </div>
    </>
  );
}

interface ColumnProps {
  readonly status: StatusCode;
  readonly count: number | undefined;
  readonly filter: IssueFilter;
  readonly dragging: string | null;
  setDragging(id: string | null): void;
}

function Column({ status, count, filter, dragging, setDragging }: ColumnProps) {
  const navigate = useNavigate();
  const { rows, setRange } = useBoardColumn(status, filter);
  usePreloadDetails(rows.map((r) => r.id));
  const body = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<number | null>(null);

  const others = rows.filter((r) => r.id !== dragging);

  const indexAt = (e: DragEvent) => {
    const cards = [...(body.current?.querySelectorAll<HTMLElement>("[data-card]") ?? [])].filter((c) => c.dataset.card !== dragging);
    const i = cards.findIndex((c) => {
      const r = c.getBoundingClientRect();
      return e.clientY < r.top + r.height / 2;
    });
    return i === -1 ? cards.length : i;
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/plain") || dragging;
    const index = indexAt(e);
    setAt(null);
    setDragging(null);
    if (id) void commands.moveIssue(id, status, others[index - 1]?.kanbanorder ?? null, others[index]?.kanbanorder ?? null);
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
      onDrop={onDrop}
    >
      <header className="col-head">
        <StatusIcon status={status} />
        {STATUS_LABELS[status]}
        <span className="count mono" data-count>
          {count?.toLocaleString()}
        </span>
      </header>
      <div
        ref={body}
        className="cards"
        onScroll={(e) => {
          const el = e.currentTarget;
          if (rows.length < (count ?? Infinity) && el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM) setRange(0, rows.length + GROW);
        }}
      >
        {count === 0 && <div className="col-empty">No issues</div>}
        {rows.map((issue) => {
          const mine = issue.id === dragging;
          const line = !mine && at === seen++;
          return (
            <div key={issue.id}>
              {line && <div className="drop-line" data-drop />}
              <Card issue={issue} dragging={mine} onOpen={() => void navigate({ to: "/issue/$id", params: { id: issue.id }, search: keepSearch })} setDragging={setDragging} />
            </div>
          );
        })}
        {at !== null && at >= others.length && <div className="drop-line" data-drop />}
      </div>
    </section>
  );
}

function Card({ issue, dragging, onOpen, setDragging }: { issue: Issue; dragging: boolean; onOpen(): void; setDragging(id: string | null): void }) {
  return (
    <article
      className={`card${dragging ? " dragging" : ""}`}
      data-card={issue.id}
      draggable
      onClick={onOpen}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", issue.id);
        e.dataTransfer.effectAllowed = "move";
        setDragging(issue.id);
      }}
      onDragEnd={() => setDragging(null)}
    >
      <div className="card-top">
        <PriorityIcon priority={issue.priority} />
        <span>{shortId(issue.id)}</span>
        {issue.dirty && <span className="dot" title="Not synced yet" data-dirty />}
      </div>
      <div className="card-title">{issue.title}</div>
    </article>
  );
}

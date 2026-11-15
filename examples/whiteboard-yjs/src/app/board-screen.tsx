import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import type { Board, BoardView, SaveState, Style, Workspace } from "../model/index.ts";
import { createController, type Controller } from "./core/input.ts";
import { TOOL_KEYS, type Action, type Tool } from "./core/keys.ts";
import { useBoardSlice, useSession, useUi, useWorkspace } from "./hooks.ts";
import { canvasMeasure } from "./paint.ts";
import { Stage } from "./stage.tsx";

export function BoardScreen({ board }: { board: Board }) {
  const { ws } = useSession();
  const [controller] = useState(() => createController(board, { measure: canvasMeasure() }));
  const meta = useWorkspace(ws).boards.find((b) => b.id === board.id);
  const navigate = useNavigate();

  useEffect(() => {
    if (meta) return;
    controller.send({ type: "abandon" });
    void navigate({ to: "/", state: { notice: "This board was deleted in another tab." } });
  }, [meta, controller, navigate]);

  return (
    <div className="board">
      <header className="board-header">
        <Link to="/" className="back">
          Boards
        </Link>
        <h1>{meta?.title}</h1>
        <BoardSaveBadge board={board} ws={ws} />
      </header>
      <div className="board-body">
        <Toolbar board={board} controller={controller} />
        <StylePanel board={board} controller={controller} />
        <Stage board={board} controller={controller} />
      </div>
    </div>
  );
}

const act = (controller: Controller, action: Action) => controller.send({ type: "do", action });

const ICONS: Record<Tool, ReactNode> = {
  select: <path d="M5 3l12 7-5.5 1.5L9 17z" />,
  rect: <rect x="3.5" y="5" width="13" height="10" rx="1" />,
  ellipse: <ellipse cx="10" cy="10" rx="7" ry="5.5" />,
  diamond: <path d="M10 3l7 7-7 7-7-7z" />,
  arrow: <path d="M3.5 16.5L16 4m0 0H9.5M16 4v6.5" />,
  text: <path d="M4 5V3.5h12V5M10 3.5v13M7.5 16.5h5" />,
  pen: <path d="M3 17c3-1 4-5 6-7s3-1 4-3 2-3 3.500-3" />,
};

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

const TOOLS = Object.keys(TOOL_KEYS) as Tool[];

function Toolbar({ board, controller }: { board: Board; controller: Controller }): ReactNode {
  const { tool } = useUi(controller);
  const canUndo = useBoardSlice(board, (v) => v.canUndo);
  const canRedo = useBoardSlice(board, (v) => v.canRedo);
  const selected = useBoardSlice(board, (v) => v.selection.size);
  const zoom = useBoardSlice(board, (v) => Math.round(v.viewport.zoom * 100));
  const none = selected === 0;
  return (
    <div className="toolbar" role="toolbar" aria-label="Tools" onPointerDown={(e) => e.preventDefault()}>
      {TOOLS.map((t) => (
        <button
          key={t}
          className="tool"
          aria-pressed={tool === t}
          aria-label={t}
          title={`${t} (${TOOL_KEYS[t].toUpperCase()})`}
          onClick={() => act(controller, { type: "tool", tool: t })}
        >
          <Icon>{ICONS[t]}</Icon>
        </button>
      ))}
      <span className="sep" />
      <button className="tool txt" disabled={!canUndo} title="Undo (Mod+Z)" onClick={() => act(controller, { type: "undo" })}>
        Undo
      </button>
      <button className="tool txt" disabled={!canRedo} title="Redo (Mod+Shift+Z)" onClick={() => act(controller, { type: "redo" })}>
        Redo
      </button>
      <span className="sep" />
      <button className="tool txt" disabled={none} title="Duplicate (Mod+D)" onClick={() => act(controller, { type: "duplicate" })}>
        Duplicate
      </button>
      <button className="tool txt" disabled={none} title="Bring to front (Mod+Shift+])" onClick={() => act(controller, { type: "reorder", to: "front" })}>
        Front
      </button>
      <button className="tool txt" disabled={none} title="Send to back (Mod+Shift+[)" onClick={() => act(controller, { type: "reorder", to: "back" })}>
        Back
      </button>
      <button className="tool txt" disabled={none} title="Delete (Delete)" onClick={() => act(controller, { type: "delete" })}>
        Delete
      </button>
      <span className="sep" />
      <button className="tool txt zoom" title="Fit to content (Shift+1)" onClick={() => act(controller, { type: "zoom", to: "fit" })}>
        {zoom}%
      </button>
    </div>
  );
}

type StyleSummary = { readonly [K in keyof Style]: Style[K] | "mixed" } | null;

function summarize(view: BoardView): StyleSummary {
  let summary: { -readonly [K in keyof Style]: Style[K] | "mixed" } | null = null;
  for (const id of view.selection) {
    const s = view.shapes.get(id);
    if (!s) continue;
    if (!summary) summary = { stroke: s.stroke, fill: s.fill, strokeWidth: s.strokeWidth };
    else {
      if (summary.stroke !== s.stroke) summary.stroke = "mixed";
      if (summary.fill !== s.fill) summary.fill = "mixed";
      if (summary.strokeWidth !== s.strokeWidth) summary.strokeWidth = "mixed";
    }
  }
  return summary;
}

function sameSummary(a: StyleSummary, b: StyleSummary): boolean {
  if (a === b) return true;
  return a !== null && b !== null && a.stroke === b.stroke && a.fill === b.fill && a.strokeWidth === b.strokeWidth;
}

const STROKES = ["#111111", "#e03131", "#2f9e44", "#1971c2", "#f08c00", "#9c36b5"];
const FILLS = [null, "#ffc9c9", "#b2f2bb", "#a5d8ff", "#ffec99", "#eebefa"];
const WIDTHS = [1, 2, 4, 8];

function StylePanel({ board, controller }: { board: Board; controller: Controller }): ReactNode {
  const summary = useBoardSlice(board, summarize, sameSummary);
  const { style } = useUi(controller);
  const shown = summary ?? style;
  const set = (edit: Partial<Style>) => act(controller, { type: "style", edit });
  return (
    <div className="panel" aria-label="Style" onPointerDown={(e) => e.preventDefault()}>
      <div className="panel-row" role="group" aria-label="Stroke">
        {STROKES.map((c) => (
          <button key={c} className="swatch" style={{ background: c }} aria-label={`stroke ${c}`} aria-pressed={shown.stroke === c} onClick={() => set({ stroke: c })} />
        ))}
      </div>
      <div className="panel-row" role="group" aria-label="Fill">
        {FILLS.map((c) => (
          <button
            key={c ?? "none"}
            className={c ? "swatch" : "swatch none"}
            style={c ? { background: c } : undefined}
            aria-label={c ? `fill ${c}` : "no fill"}
            aria-pressed={shown.fill === c}
            onClick={() => set({ fill: c })}
          />
        ))}
      </div>
      <div className="panel-row" role="group" aria-label="Width">
        {WIDTHS.map((w) => (
          <button key={w} className="width" aria-label={`width ${w}`} aria-pressed={shown.strokeWidth === w} onClick={() => set({ strokeWidth: w })}>
            <i style={{ height: w }} />
          </button>
        ))}
      </div>
    </div>
  );
}

const worst = (a: SaveState, b: SaveState): SaveState => {
  if (a.kind === "error") return a;
  if (b.kind === "error") return b;
  return a.kind === "saving" ? a : b;
};

function BoardSaveBadge({ board, ws }: { board: Board; ws: Workspace }): ReactNode {
  const { save: index } = useWorkspace(ws);
  const shapes = useBoardSlice(board, (v) => v.save);
  const skipped = useBoardSlice(board, (v) => v.skipped);
  return <SaveStatus state={worst(shapes, index)} skipped={skipped} retry={() => Promise.all([ws.flush(), board.flush()])} />;
}

export function WorkspaceSaveBadge({ ws }: { ws: Workspace }): ReactNode {
  const { save } = useWorkspace(ws);
  return <SaveStatus state={save} skipped={0} retry={() => ws.flush()} />;
}

function SaveStatus({ state, skipped, retry }: { state: SaveState; skipped: number; retry: () => Promise<unknown> }): ReactNode {
  return (
    <span className="save" role="status" data-state={state.kind}>
      {state.kind === "saved" && "Saved"}
      {state.kind === "saving" && "Saving…"}
      {state.kind === "error" && `Not saved: ${state.error.message}`}
      {state.kind === "error" && (
        <button className="btn small" onClick={() => void retry().catch(() => {})}>
          Retry
        </button>
      )}
      {skipped > 0 && ` · ${skipped} unreadable`}
    </span>
  );
}

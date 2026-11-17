import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import type { Board, BoardMeta, BoardView, SaveState, Style, Workspace } from "../model/index.ts";
import { createController, type Controller } from "./core/input.ts";
import { TOOL_KEYS, type Action, type Tool } from "./core/keys.ts";
import { useBoardSlice, useSession, useUi, useWorkspace } from "./hooks.ts";
import { Icon, ICON } from "./icons.tsx";
import { canvasMeasure } from "./paint.ts";
import { Stage } from "./stage.tsx";
import { editable, IconButton, keys, MAC, SaveStatus, TitleInput } from "./ui.tsx";

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
      <Stage board={board} controller={controller} />
      <EmptyHint board={board} controller={controller} />
      <header className="hud-top">
        <div className="island title-island">
          <Link to="/" className="icon-btn" aria-label="All boards" data-tip="All boards">
            <Icon>{ICON.back}</Icon>
          </Link>
          <span className="island-sep" />
          {meta && <BoardTitle ws={ws} meta={meta} />}
        </div>
        <div className="island status-island">
          <BoardSaveBadge board={board} ws={ws} />
        </div>
      </header>
      <Toolbar controller={controller} />
      <StylePanel board={board} controller={controller} />
      <div className="hud-bottom">
        <ViewControls board={board} controller={controller} />
        <History board={board} controller={controller} />
        <Shortcuts />
      </div>
    </div>
  );
}

const act = (controller: Controller, action: Action) => controller.send({ type: "do", action });

const K = {
  undo: keys("Mod", "Z"),
  redo: keys("Mod", "Shift", "Z"),
  selectAll: keys("Mod", "A"),
  duplicate: keys("Mod", "D"),
  remove: keys("Delete"),
  toFront: keys("Mod", "Shift", "]"),
  forward: keys("Mod", "]"),
  backward: keys("Mod", "["),
  toBack: keys("Mod", "Shift", "["),
  zoomIn: keys("Mod", "="),
  zoomOut: keys("Mod", "-"),
  zoomReset: keys("Mod", "0"),
  fit: keys("Shift", "1"),
};

function BoardTitle({ ws, meta }: { ws: Workspace; meta: BoardMeta }): ReactNode {
  const [renaming, setRenaming] = useState(false);
  return (
    <h1 className="board-title">
      {renaming ? (
        <TitleInput ws={ws} meta={meta} className="title-input" onDone={() => setRenaming(false)} />
      ) : (
        <button type="button" className="title-btn" data-tip="Rename board" aria-label={`${meta.title}, rename`} onClick={() => setRenaming(true)}>
          {meta.title}
        </button>
      )}
    </h1>
  );
}

const TOOL_LABEL: Readonly<Record<Tool, string>> = {
  select: "Select",
  rect: "Rectangle",
  ellipse: "Ellipse",
  diamond: "Diamond",
  arrow: "Arrow",
  text: "Text",
  pen: "Pen",
};
const TOOL_GROUPS: readonly (readonly Tool[])[] = [["select"], ["rect", "ellipse", "diamond"], ["arrow", "pen", "text"]];

const keepFocus = (e: PointerEvent) => e.preventDefault();

function Toolbar({ controller }: { controller: Controller }): ReactNode {
  const { tool } = useUi(controller);
  return (
    <div className="island toolbar" role="toolbar" aria-label="Tools" onPointerDown={keepFocus}>
      {TOOL_GROUPS.map((group, i) => (
        <div key={i} className="tool-group">
          {group.map((t) => (
            <IconButton
              key={t}
              label={TOOL_LABEL[t]}
              icon={ICON[t]}
              shortcut={keys(TOOL_KEYS[t].toUpperCase())}
              aria-pressed={tool === t}
              onClick={() => act(controller, { type: "tool", tool: t })}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function History({ board, controller }: { board: Board; controller: Controller }): ReactNode {
  const canUndo = useBoardSlice(board, (v) => v.canUndo);
  const canRedo = useBoardSlice(board, (v) => v.canRedo);
  return (
    <div className="island" role="group" aria-label="History" onPointerDown={keepFocus}>
      <IconButton label="Undo" icon={ICON.undo} shortcut={K.undo} disabled={!canUndo} onClick={() => act(controller, { type: "undo" })} />
      <IconButton label="Redo" icon={ICON.redo} shortcut={K.redo} disabled={!canRedo} onClick={() => act(controller, { type: "redo" })} />
    </div>
  );
}

function ViewControls({ board, controller }: { board: Board; controller: Controller }): ReactNode {
  const zoom = useBoardSlice(board, (v) => Math.round(v.viewport.zoom * 100));
  const empty = useBoardSlice(board, (v) => v.order.length === 0);
  const zoomTo = (to: "in" | "out" | "reset" | "fit") => act(controller, { type: "zoom", to });
  return (
    <div className="island" role="group" aria-label="Zoom" onPointerDown={keepFocus}>
      <IconButton label="Zoom out" icon={ICON.minus} shortcut={K.zoomOut} onClick={() => zoomTo("out")} />
      <button
        type="button"
        className="zoom-btn"
        aria-label={`${zoom}%, reset zoom`}
        aria-keyshortcuts={K.zoomReset.aria}
        data-tip="Reset zoom"
        data-keys={K.zoomReset.label}
        onClick={() => zoomTo("reset")}
      >
        {zoom}%
      </button>
      <IconButton label="Zoom in" icon={ICON.plus} shortcut={K.zoomIn} onClick={() => zoomTo("in")} />
      <span className="island-sep" />
      <IconButton label="Zoom to fit" icon={ICON.fit} shortcut={K.fit} disabled={empty} onClick={() => zoomTo("fit")} />
    </div>
  );
}

type StyleSummary = {
  readonly style: { readonly [K in keyof Style]: Style[K] | "mixed" };
  readonly fillable: boolean;
  readonly stroked: boolean;
} | null;

function summarize(view: BoardView): StyleSummary {
  let style: { -readonly [K in keyof Style]: Style[K] | "mixed" } | null = null;
  let fillable = false;
  let stroked = false;
  for (const id of view.selection) {
    const s = view.shapes.get(id);
    if (!s) continue;
    fillable ||= s.kind !== "arrow" && s.kind !== "pen";
    stroked ||= s.kind !== "text";
    if (!style) style = { stroke: s.stroke, fill: s.fill, strokeWidth: s.strokeWidth };
    else {
      if (style.stroke !== s.stroke) style.stroke = "mixed";
      if (style.fill !== s.fill) style.fill = "mixed";
      if (style.strokeWidth !== s.strokeWidth) style.strokeWidth = "mixed";
    }
  }
  return style && { style, fillable, stroked };
}

function sameSummary(a: StyleSummary, b: StyleSummary): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.fillable === b.fillable &&
    a.stroked === b.stroked &&
    a.style.stroke === b.style.stroke &&
    a.style.fill === b.style.fill &&
    a.style.strokeWidth === b.style.strokeWidth
  );
}

const STROKES = [
  ["#111111", "Black"],
  ["#e03131", "Red"],
  ["#2f9e44", "Green"],
  ["#1971c2", "Blue"],
  ["#f08c00", "Orange"],
  ["#9c36b5", "Violet"],
] as const;
const FILLS = [
  [null, "No fill"],
  ["#ffc9c9", "Red"],
  ["#b2f2bb", "Green"],
  ["#a5d8ff", "Blue"],
  ["#ffec99", "Yellow"],
  ["#eebefa", "Violet"],
] as const;
const WIDTHS = [
  [1, "Thin"],
  [2, "Regular"],
  [4, "Bold"],
  [8, "Heavy"],
] as const;

function StylePanel({ board, controller }: { board: Board; controller: Controller }): ReactNode {
  const summary = useBoardSlice(board, summarize, sameSummary);
  const { tool, style } = useUi(controller);
  if (!summary && tool === "select") return null;
  const shown = summary?.style ?? style;
  const fillable = summary ? summary.fillable : tool === "rect" || tool === "ellipse" || tool === "diamond";
  const stroked = summary ? summary.stroked : tool !== "text";
  const set = (edit: Partial<Style>) => act(controller, { type: "style", edit });
  return (
    <aside className="island panel" aria-label="Style" onPointerDown={keepFocus}>
      <PanelRow label={tool === "text" || (summary && !summary.stroked) ? "Color" : "Stroke"}>
        {STROKES.map(([c, name]) => (
          <button key={c} type="button" className="swatch" style={{ background: c }} aria-label={name} aria-pressed={shown.stroke === c} onClick={() => set({ stroke: c })} />
        ))}
      </PanelRow>
      {fillable && (
        <PanelRow label="Fill">
          {FILLS.map(([c, name]) => (
            <button
              key={c ?? "none"}
              type="button"
              className={c ? "swatch" : "swatch none"}
              style={c ? { background: c } : undefined}
              aria-label={name}
              aria-pressed={shown.fill === c}
              onClick={() => set({ fill: c })}
            />
          ))}
        </PanelRow>
      )}
      {stroked && (
        <PanelRow label="Width">
          {WIDTHS.map(([w, name]) => (
            <button key={w} type="button" className="width" aria-label={name} aria-pressed={shown.strokeWidth === w} onClick={() => set({ strokeWidth: w })}>
              <i style={{ height: w }} />
            </button>
          ))}
        </PanelRow>
      )}
      {summary && (
        <PanelRow label="Actions">
          <IconButton label="Send to back" icon={ICON.toBack} shortcut={K.toBack} onClick={() => act(controller, { type: "reorder", to: "back" })} />
          <IconButton label="Send backward" icon={ICON.backward} shortcut={K.backward} onClick={() => act(controller, { type: "reorder", to: "backward" })} />
          <IconButton label="Bring forward" icon={ICON.forward} shortcut={K.forward} onClick={() => act(controller, { type: "reorder", to: "forward" })} />
          <IconButton label="Bring to front" icon={ICON.toFront} shortcut={K.toFront} onClick={() => act(controller, { type: "reorder", to: "front" })} />
          <span className="island-sep" />
          <IconButton label="Duplicate" icon={ICON.duplicate} shortcut={K.duplicate} onClick={() => act(controller, { type: "duplicate" })} />
          <IconButton label="Delete" icon={ICON.trash} shortcut={K.remove} className="danger" onClick={() => act(controller, { type: "delete" })} />
        </PanelRow>
      )}
    </aside>
  );
}

function PanelRow({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="panel-section" role="group" aria-label={label}>
      <span className="panel-label">{label}</span>
      <div className="panel-row">{children}</div>
    </div>
  );
}

const HINTS: Readonly<Record<Tool, { readonly title: string; readonly body?: ReactNode; readonly keyboard?: ReactNode }>> = {
  select: {
    title: "Start drawing",
    body: (
      <>
        Pick a tool to begin
        <span className="hint-keys">
          , or press <kbd>R</kbd> <kbd>O</kbd> <kbd>D</kbd> <kbd>A</kbd> <kbd>P</kbd>. Double-click anywhere to write
        </span>
        .
      </>
    ),
  },
  rect: { title: "Drag to draw a rectangle", keyboard: "Hold Shift for a square, or click for a default size." },
  ellipse: { title: "Drag to draw an ellipse", keyboard: "Hold Shift for a circle, or click for a default size." },
  diamond: { title: "Drag to draw a diamond", keyboard: "Hold Shift to keep it even, or click for a default size." },
  arrow: { title: "Drag to draw an arrow", keyboard: "Hold Shift to snap the angle to 15° steps." },
  text: { title: "Click anywhere to write", keyboard: <>Press <kbd>Esc</kbd> when you are done.</> },
  pen: { title: "Drag to draw freehand", keyboard: <>Press <kbd>Esc</kbd> to go back to Select.</> },
};

function EmptyHint({ board, controller }: { board: Board; controller: Controller }): ReactNode {
  const empty = useBoardSlice(board, (v) => v.order.length === 0);
  const { tool, editing } = useUi(controller);
  if (!empty || editing) return null;
  const hint = HINTS[tool];
  return (
    <div className="empty-hint" aria-live="polite">
      <p className="empty-title">{hint.title}</p>
      {hint.body && <p className="empty-body">{hint.body}</p>}
      {hint.keyboard && <p className="empty-body hint-keys">{hint.keyboard}</p>}
    </div>
  );
}

const SHORTCUT_GROUPS: readonly { readonly title: string; readonly rows: readonly (readonly [string, string])[] }[] = [
  {
    title: "Tools",
    rows: TOOL_GROUPS.flat().map((t) => [TOOL_LABEL[t], TOOL_KEYS[t].toUpperCase()] as const),
  },
  {
    title: "Edit",
    rows: [
      ["Undo", K.undo.label],
      ["Redo", K.redo.label],
      ["Select all", K.selectAll.label],
      ["Duplicate", K.duplicate.label],
      ["Delete", K.remove.label],
      ["Edit text", "Enter"],
      ["Nudge", "Arrows"],
      ["Nudge by 10", MAC ? "⇧ Arrows" : "Shift+Arrows"],
      ["Cancel, deselect", "Esc"],
    ],
  },
  {
    title: "Arrange",
    rows: [
      ["Bring forward", K.forward.label],
      ["Send backward", K.backward.label],
      ["Bring to front", K.toFront.label],
      ["Send to back", K.toBack.label],
    ],
  },
  {
    title: "View",
    rows: [
      ["Zoom in", K.zoomIn.label],
      ["Zoom out", K.zoomOut.label],
      ["Reset zoom", K.zoomReset.label],
      ["Zoom to fit", K.fit.label],
      ["Zoom with wheel", MAC ? "⌘ Scroll" : "Ctrl+Scroll"],
      ["Pan", "Space + drag"],
    ],
  },
];

function Shortcuts(): ReactNode {
  const sheet = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = sheet.current!;
      if (e.key === "Escape" && el.matches(":popover-open")) {
        e.stopPropagation();
        el.hidePopover();
      } else if (e.key === "?" && !e.metaKey && !e.ctrlKey && !editable(e.target)) {
        e.preventDefault();
        el.togglePopover();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  return (
    <>
      <IconButton label="Keyboard shortcuts" icon={ICON.help} shortcut={keys("?")} className="island help-btn" popoverTarget="shortcuts" />
      <div ref={sheet} id="shortcuts" popover="auto" className="shortcuts" role="dialog" aria-label="Keyboard shortcuts">
        <h2>Keyboard shortcuts</h2>
        <div className="shortcut-groups">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.title}>
              <h3>{group.title}</h3>
              <dl>
                {group.rows.map(([action, key]) => (
                  <div key={action}>
                    <dt>{action}</dt>
                    <dd>
                      <kbd>{key}</kbd>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </>
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

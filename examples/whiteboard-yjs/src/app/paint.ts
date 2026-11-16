import type { BoardView, NewShape, Shape, ShapeId } from "../model/index.ts";
import { toScreen, visibleRect } from "./core/camera.ts";
import {
  arrowHead,
  HANDLE_PX,
  handlePoints,
  handlesFor,
  inkOverlaps,
  rectOf,
  selectionRect,
} from "./core/geometry.ts";
import type { Overlay } from "./core/input.ts";
import { fontPxOf, FONT, LINE_HEIGHT, linesOf, type Measure } from "./core/text.ts";

export type CanvasSize = { readonly w: number; readonly h: number; readonly dpr: number };

const LOD_PX = 3;
const TEXT_LOD_PX = 4;
const OUTLINE_LIMIT = 1000;

type Theme = { readonly canvas: string; readonly accent: string };

/** The font last set on the scene context: parsing a font string is the costly part of drawing text. */
let currentFont = "";

function drawShape(ctx: CanvasRenderingContext2D, s: Shape | NewShape, zoom: number): void {
  const r = rectOf(s);
  const bw = r.maxX - r.minX;
  const bh = r.maxY - r.minY;
  ctx.lineWidth = Math.max(s.strokeWidth, 1 / zoom);
  ctx.strokeStyle = s.stroke;
  switch (s.kind) {
    case "rect":
      ctx.beginPath();
      ctx.rect(r.minX, r.minY, bw, bh);
      fillAndStroke(ctx, s);
      return;
    case "ellipse":
      ctx.beginPath();
      ctx.ellipse(r.minX + bw / 2, r.minY + bh / 2, bw / 2, bh / 2, 0, 0, Math.PI * 2);
      fillAndStroke(ctx, s);
      return;
    case "diamond":
      ctx.beginPath();
      ctx.moveTo(r.minX + bw / 2, r.minY);
      ctx.lineTo(r.maxX, r.minY + bh / 2);
      ctx.lineTo(r.minX + bw / 2, r.maxY);
      ctx.lineTo(r.minX, r.minY + bh / 2);
      ctx.closePath();
      fillAndStroke(ctx, s);
      return;
    case "arrow": {
      const x1 = s.x + s.w;
      const y1 = s.y + s.h;
      const angle = Math.atan2(s.h, s.w);
      const head = arrowHead(s.strokeWidth);
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(x1, y1);
      for (const side of [-0.45, 0.45]) {
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1 - head * Math.cos(angle + side), y1 - head * Math.sin(angle + side));
      }
      ctx.stroke();
      return;
    }
    case "text": {
      if (s.fill) {
        ctx.fillStyle = s.fill;
        ctx.fillRect(r.minX, r.minY, bw, bh);
      }
      const fontPx = fontPxOf(s);
      const lines = linesOf(s.text);
      ctx.fillStyle = s.stroke;
      if (fontPx * zoom < TEXT_LOD_PX) {
        lines.forEach((line, i) => {
          const width = Math.min(bw, line.length * fontPx * 0.5);
          ctx.fillRect(r.minX, r.minY + (i + 0.3) * fontPx * LINE_HEIGHT, width, fontPx * 0.4);
        });
        return;
      }
      const font = `${fontPx}px ${FONT}`;
      if (font !== currentFont) {
        ctx.font = font;
        currentFont = font;
      }
      ctx.textBaseline = "top";
      if (bw <= 0) return;
      lines.forEach((line, i) => {
        ctx.fillText(line, r.minX, r.minY + i * fontPx * LINE_HEIGHT + ((LINE_HEIGHT - 1) * fontPx) / 2, bw);
      });
      return;
    }
    case "pen": {
      const pts = s.points;
      ctx.beginPath();
      if (pts.length <= 2) {
        ctx.fillStyle = s.stroke;
        ctx.arc(s.x + (pts[0]! / 65535) * s.w, s.y + (pts[1]! / 65535) * s.h, s.strokeWidth / 2, 0, Math.PI * 2);
        ctx.fill();
        return;
      }
      ctx.moveTo(s.x + (pts[0]! / 65535) * s.w, s.y + (pts[1]! / 65535) * s.h);
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(s.x + (pts[i]! / 65535) * s.w, s.y + (pts[i + 1]! / 65535) * s.h);
      ctx.stroke();
      return;
    }
  }
}

function fillAndStroke(ctx: CanvasRenderingContext2D, s: Shape | NewShape): void {
  if (s.fill) {
    ctx.fillStyle = s.fill;
    ctx.fill();
  }
  ctx.stroke();
}

function paintScene(ctx: CanvasRenderingContext2D, view: BoardView, size: CanvasSize, skip: ShapeId | null, theme: Theme): Shape[] {
  const { viewport, order, shapes } = view;
  const { zoom } = viewport;
  ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
  ctx.fillStyle = theme.canvas;
  ctx.fillRect(0, 0, size.w, size.h);
  const scale = size.dpr * zoom;
  ctx.setTransform(scale, 0, 0, scale, -viewport.x * scale, -viewport.y * scale);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  currentFont = "";
  const visible = visibleRect(viewport, size);
  const seen: Shape[] = new Array(order.length);
  for (let i = 0; i < order.length; i++) {
    const s = shapes.get(order[i]!)!;
    seen[i] = s;
    if (s.id === skip || !inkOverlaps(s, visible)) continue;
    if (Math.max(Math.abs(s.w), Math.abs(s.h)) * zoom < LOD_PX) {
      ctx.fillStyle = s.fill ?? s.stroke;
      ctx.fillRect(Math.min(s.x, s.x + s.w), Math.min(s.y, s.y + s.h), Math.max(Math.abs(s.w), 1 / zoom), Math.max(Math.abs(s.h), 1 / zoom));
      continue;
    }
    drawShape(ctx, s, zoom);
  }
  return seen;
}

function paintOverlay(ctx: CanvasRenderingContext2D, view: BoardView, overlay: Overlay, size: CanvasSize, theme: Theme): void {
  const { viewport } = view;
  ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
  ctx.clearRect(0, 0, size.w, size.h);
  if (overlay.preview) {
    const scale = size.dpr * viewport.zoom;
    ctx.setTransform(scale, 0, 0, scale, -viewport.x * scale, -viewport.y * scale);
    ctx.globalAlpha = 0.6;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    drawShape(ctx, overlay.preview, viewport.zoom);
    ctx.globalAlpha = 1;
    ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
  }
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 1;
  const outline = (minX: number, minY: number, maxX: number, maxY: number) => {
    const a = toScreen(viewport, { x: minX, y: minY });
    const b = toScreen(viewport, { x: maxX, y: maxY });
    ctx.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(b.x - a.x), Math.round(b.y - a.y));
  };
  if (view.selection.size <= OUTLINE_LIMIT) {
    for (const id of view.selection) {
      const s = view.shapes.get(id);
      if (!s || s.id === overlay.editing || s.kind === "arrow") continue;
      const r = rectOf(s);
      outline(r.minX, r.minY, r.maxX, r.maxY);
    }
  }
  const union = selectionRect(view);
  if (union && view.selection.size > 1) {
    ctx.setLineDash([4, 3]);
    outline(union.minX, union.minY, union.maxX, union.maxY);
    ctx.setLineDash([]);
  }
  const handles = overlay.editing ? { kind: "none" as const } : handlesFor(view);
  for (const [id, at] of handlePoints(handles)) {
    const p = toScreen(viewport, at);
    ctx.fillStyle = id === overlay.hover ? theme.accent : "#ffffff";
    ctx.beginPath();
    if (id === "start" || id === "end") ctx.arc(p.x, p.y, HANDLE_PX / 2, 0, Math.PI * 2);
    else ctx.rect(p.x - HANDLE_PX / 2, p.y - HANDLE_PX / 2, HANDLE_PX, HANDLE_PX);
    ctx.fill();
    ctx.stroke();
  }
  if (overlay.marquee) {
    const m = overlay.marquee;
    const a = toScreen(viewport, { x: m.minX, y: m.minY });
    const b = toScreen(viewport, { x: m.maxX, y: m.maxY });
    ctx.fillStyle = theme.accent;
    ctx.globalAlpha = 0.08;
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.globalAlpha = 1;
    ctx.strokeRect(a.x + 0.5, a.y + 0.5, b.x - a.x, b.y - a.y);
  }
}

export interface Renderer {
  resize(size: CanvasSize): void;
  paint(view: BoardView, overlay: Overlay): void;
}

type Painted = {
  readonly order: readonly ShapeId[];
  readonly viewport: BoardView["viewport"];
  readonly skip: ShapeId | null;
  readonly shapes: readonly Shape[];
};

export function createRenderer(scene: HTMLCanvasElement, top: HTMLCanvasElement): Renderer {
  const sctx = scene.getContext("2d", { alpha: false })!;
  const octx = top.getContext("2d")!;
  const css = getComputedStyle(scene);
  const theme: Theme = { canvas: css.getPropertyValue("--canvas").trim(), accent: css.getPropertyValue("--accent").trim() };
  let size: CanvasSize = { w: 0, h: 0, dpr: 1 };
  let painted: Painted | null = null;
  let lastView: BoardView | null = null;
  let lastOverlay: Overlay | null = null;

  const changedSince = (view: BoardView, shapes: readonly Shape[]): boolean => {
    for (let i = 0; i < view.order.length; i++) if (view.shapes.get(view.order[i]!) !== shapes[i]) return true;
    return false;
  };

  return {
    resize(next) {
      size = next;
      for (const canvas of [scene, top]) {
        canvas.width = Math.max(1, Math.round(next.w * next.dpr));
        canvas.height = Math.max(1, Math.round(next.h * next.dpr));
      }
      painted = null;
      lastView = null;
    },
    paint(view, overlay) {
      if (size.w === 0) return;
      const dirty =
        !painted ||
        view.order !== painted.order ||
        view.viewport !== painted.viewport ||
        overlay.editing !== painted.skip ||
        changedSince(view, painted.shapes);
      if (dirty) {
        painted = {
          order: view.order,
          viewport: view.viewport,
          skip: overlay.editing,
          shapes: paintScene(sctx, view, size, overlay.editing, theme),
        };
      }
      if (dirty || view !== lastView || overlay !== lastOverlay) paintOverlay(octx, view, overlay, size, theme);
      lastView = view;
      lastOverlay = overlay;
    },
  };
}

/** Hinting makes small sizes a little off; the painter's maxWidth absorbs it. */
export function canvasMeasure(): Measure {
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.font = `100px ${FONT}`;
  return (line, px) => (ctx.measureText(line).width * px) / 100;
}

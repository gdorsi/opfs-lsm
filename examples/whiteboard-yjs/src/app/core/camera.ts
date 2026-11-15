/**
 * The screen <-> board transform. The model owns the viewport (`board.setViewport`, local to the tab, not stored);
 * these functions only compute the next one. Pure.
 *
 * Convention: `viewport.{x, y}` is the board point at the stage's top-left corner; `zoom` is screen px per board unit.
 *   screen = (board - (x, y)) * zoom        board = screen / zoom + (x, y)
 */
import type { Point, Viewport } from "../../model/index.ts";
import type { Rect } from "./geometry.ts";

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 8;

/** The stage size in CSS px. */
export type Size = { readonly w: number; readonly h: number };

const clampZoom = (zoom: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

export function toBoard(v: Viewport, screen: Point): Point {
  return { x: screen.x / v.zoom + v.x, y: screen.y / v.zoom + v.y };
}

export function toScreen(v: Viewport, board: Point): Point {
  return { x: (board.x - v.x) * v.zoom, y: (board.y - v.y) * v.zoom };
}

/** The board rect the stage shows. The painter culls against it. */
export function visibleRect(v: Viewport, stage: Size): Rect {
  return { minX: v.x, minY: v.y, maxX: v.x + stage.w / v.zoom, maxY: v.y + stage.h / v.zoom };
}

/** Moves the view by a screen delta (a drag of the hand, or a wheel scroll). */
export function panBy(v: Viewport, dxScreen: number, dyScreen: number): Viewport {
  return { x: v.x - dxScreen / v.zoom, y: v.y - dyScreen / v.zoom, zoom: v.zoom };
}

/** Zooms by `factor`, keeping the board point under `anchor` (screen) where it is. Clamped to MIN_ZOOM..MAX_ZOOM. */
export function zoomAt(v: Viewport, anchor: Point, factor: number): Viewport {
  const zoom = clampZoom(v.zoom * factor);
  const b = toBoard(v, anchor);
  return { x: b.x - anchor.x / zoom, y: b.y - anchor.y / zoom, zoom };
}

/** A wheel's delta in px. deltaMode 1 is lines (16 px), 2 is pages (the stage height). */
export function wheelPixels(delta: number, deltaMode: number, stageHeight: number): number {
  return deltaMode === 1 ? delta * 16 : deltaMode === 2 ? delta * stageHeight : delta;
}

/**
 * The zoom factor of one ctrl/cmd-wheel event. Trackpad pinch arrives as ctrl-wheel with small deltas; a mouse wheel
 * with ctrl sends +-100. Clamping |dy| to 50 keeps one mouse notch at about 1.65x.
 */
export function wheelZoomFactor(dyPixels: number): number {
  return Math.exp(-Math.min(50, Math.max(-50, dyPixels)) * 0.01);
}

/**
 * Two touches: the board point under the first midpoint stays under the current midpoint, and the zoom follows the
 * distance ratio.
 */
export function pinchViewport(start: Viewport, a0: Point, b0: Point, a1: Point, b1: Point): Viewport {
  const before = Math.hypot(a0.x - b0.x, a0.y - b0.y);
  const after = Math.hypot(a1.x - b1.x, a1.y - b1.y);
  const zoom = clampZoom(before === 0 ? start.zoom : (start.zoom * after) / before);
  const anchor = toBoard(start, { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 });
  return { x: anchor.x - (a1.x + b1.x) / 2 / zoom, y: anchor.y - (a1.y + b1.y) / 2 / zoom, zoom };
}

/** The viewport that shows `content` with `margin` px around it, never zoomed in past `maxZoom`. */
export function fitViewport(content: Rect, stage: Size, maxZoom = 1, margin = 48): Viewport {
  const w = content.maxX - content.minX;
  const h = content.maxY - content.minY;
  const room = { w: Math.max(1, stage.w - 2 * margin), h: Math.max(1, stage.h - 2 * margin) };
  const zoom = clampZoom(Math.min(maxZoom, room.w / Math.max(w, 1e-9), room.h / Math.max(h, 1e-9)));
  return {
    x: (content.minX + content.maxX) / 2 - stage.w / 2 / zoom,
    y: (content.minY + content.maxY) / 2 - stage.h / 2 / zoom,
    zoom,
  };
}

/**
 * Board coordinates the UI writes. Whole units at zoom <= 2, so Yjs stores small ints instead of float64
 * (lib0 writes an integer as a varint); 1/8 unit above, so a zoomed-in drag still moves by less than a pixel.
 */
export function snap(value: number, zoom: number): number {
  return zoom <= 2 ? Math.round(value) : Math.round(value * 8) / 8;
}

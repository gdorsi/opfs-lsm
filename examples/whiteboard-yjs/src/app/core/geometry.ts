/**
 * Board-space geometry over the model's own structures: `order` (back to front) and the live `shapes` map.
 * Pure: no DOM, no clock. Hit testing, marquee, culling and the selection's handles all read the stored frame
 * (x, y, w, h) of every kind, text included, so nothing here measures text or keeps an index.
 *
 * Every scan is O(order.length) with a bounding-box test first, and allocates nothing for a shape it rejects.
 * There is no spatial index on purpose: the scans cost under half a millisecond at 20,000 shapes.
 */
import type { BoardView, Box, Point, Shape, ShapeId } from "../../model/index.ts";

/** A normalized rectangle: min <= max on both axes. Boxes in the model may be flipped; a Rect never is. */
export type Rect = { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number };

/** What the scans read. A BoardView fits, and so does a test's plain scene. */
export type Scene = Pick<BoardView, "shapes" | "order">;

/** Pointer tolerance and handle size, in screen px. Callers divide by zoom to get board units. */
export const HIT_PX = 6;
export const HANDLE_PX = 9;

export type BoxHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export type HandleId = BoxHandle | "start" | "end";

/**
 * The handles a selection shows. Derived from the view on every read, never stored, so the painter and the hit test
 * cannot disagree.
 *  - one arrow: its two endpoints, on its raw (possibly flipped) box.
 *  - only text: the four corners, aspect kept (text scales with its box; see text.ts).
 *  - anything else: eight handles on the union box.
 */
export type Handles =
  | { readonly kind: "none" }
  | { readonly kind: "box"; readonly box: Box; readonly corners: boolean; readonly keepAspect: boolean }
  | { readonly kind: "arrow"; readonly id: ShapeId; readonly arrow: Box };

type Framed = Box & { readonly strokeWidth: number; readonly kind: Shape["kind"] };

export function rectOf(s: Box): Rect {
  return {
    minX: Math.min(s.x, s.x + s.w),
    minY: Math.min(s.y, s.y + s.h),
    maxX: Math.max(s.x, s.x + s.w),
    maxY: Math.max(s.y, s.y + s.h),
  };
}

export function rectBetween(a: Point, b: Point): Rect {
  return { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) };
}

export function boxOf(r: Rect): Box {
  return { x: r.minX, y: r.minY, w: r.maxX - r.minX, h: r.maxY - r.minY };
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export function contains(outer: Rect, inner: Rect): boolean {
  return outer.minX <= inner.minX && outer.maxX >= inner.maxX && outer.minY <= inner.minY && outer.maxY >= inner.maxY;
}

/** An arrow's head can stick out of a thin frame by this much. */
export const arrowHead = (strokeWidth: number): number => Math.max(10, 3 * strokeWidth);

const inkPad = (s: Framed): number => s.strokeWidth / 2 + (s.kind === "arrow" ? arrowHead(s.strokeWidth) : 0);

/** The frame grown by half the stroke and an arrow's head: what the painter may touch. */
export function inkRect(s: Framed): Rect {
  const r = rectOf(s);
  const pad = inkPad(s);
  return { minX: r.minX - pad, minY: r.minY - pad, maxX: r.maxX + pad, maxY: r.maxY + pad };
}

/** `inkRect(s)` meets `r`, without allocating. The painter's cull. */
export function reaches(s: Framed, r: Rect): boolean {
  const pad = inkPad(s);
  return (
    Math.min(s.x, s.x + s.w) - pad <= r.maxX &&
    Math.max(s.x, s.x + s.w) + pad >= r.minX &&
    Math.min(s.y, s.y + s.h) - pad <= r.maxY &&
    Math.max(s.y, s.y + s.h) + pad >= r.minY
  );
}

export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

const inRect = (r: Rect, p: Point): boolean => p.x >= r.minX && p.x <= r.maxX && p.y >= r.minY && p.y <= r.maxY;

/** Whether `p` is within `t` of the border of `r` and not deeper inside. */
function onBorder(r: Rect, p: Point, t: number): boolean {
  if (p.x < r.minX - t || p.x > r.maxX + t || p.y < r.minY - t || p.y > r.maxY + t) return false;
  return !(p.x > r.minX + t && p.x < r.maxX - t && p.y > r.minY + t && p.y < r.maxY - t);
}

/**
 * Whether board point `p` touches shape `s`, with tolerance `tol` in board units (HIT_PX / zoom). An unfilled box
 * is hit on its border only, so it does not swallow clicks meant for what lies inside it.
 */
export function hitShape(s: Shape, p: Point, tol: number): boolean {
  if (!reaches(s, { minX: p.x - tol, minY: p.y - tol, maxX: p.x + tol, maxY: p.y + tol })) return false;
  const t = tol + s.strokeWidth / 2;
  const r = rectOf(s);
  switch (s.kind) {
    case "text":
      return inRect(r, p);
    case "rect":
      return s.fill !== null ? inRect(r, p) || onBorder(r, p, t) : onBorder(r, p, t);
    case "ellipse": {
      const cx = (r.minX + r.maxX) / 2;
      const cy = (r.minY + r.maxY) / 2;
      const rx = (r.maxX - r.minX) / 2;
      const ry = (r.maxY - r.minY) / 2;
      if (rx === 0 || ry === 0) return distanceToSegment(p, { x: cx - rx, y: cy - ry }, { x: cx + rx, y: cy + ry }) <= t;
      const ux = (p.x - cx) / rx;
      const uy = (p.y - cy) / ry;
      if (s.fill !== null && ux * ux + uy * uy <= 1) return true;
      const angle = Math.atan2(uy, ux);
      return Math.hypot(p.x - (cx + rx * Math.cos(angle)), p.y - (cy + ry * Math.sin(angle))) <= t;
    }
    case "diamond": {
      const cx = (r.minX + r.maxX) / 2;
      const cy = (r.minY + r.maxY) / 2;
      const rx = (r.maxX - r.minX) / 2;
      const ry = (r.maxY - r.minY) / 2;
      if (s.fill !== null && rx > 0 && ry > 0 && Math.abs(p.x - cx) / rx + Math.abs(p.y - cy) / ry <= 1) return true;
      const top = { x: cx, y: r.minY };
      const right = { x: r.maxX, y: cy };
      const bottom = { x: cx, y: r.maxY };
      const left = { x: r.minX, y: cy };
      return (
        distanceToSegment(p, top, right) <= t ||
        distanceToSegment(p, right, bottom) <= t ||
        distanceToSegment(p, bottom, left) <= t ||
        distanceToSegment(p, left, top) <= t
      );
    }
    case "arrow":
      return distanceToSegment(p, { x: s.x, y: s.y }, { x: s.x + s.w, y: s.y + s.h }) <= t;
    case "pen": {
      const pts = s.points;
      const at = (i: number): Point => ({ x: s.x + (pts[i]! / 65535) * s.w, y: s.y + (pts[i + 1]! / 65535) * s.h });
      let prev = at(0);
      if (pts.length <= 2) return Math.hypot(p.x - prev.x, p.y - prev.y) <= t;
      for (let i = 2; i < pts.length; i += 2) {
        const next = at(i);
        if (distanceToSegment(p, prev, next) <= t) return true;
        prev = next;
      }
      return false;
    }
  }
}

/** The frontmost shape under `p`: walks `order` from the end. `skip` leaves one id out (the text being edited). */
export function hitTop(scene: Scene, p: Point, tol: number, skip?: ShapeId | null): ShapeId | undefined {
  for (let i = scene.order.length - 1; i >= 0; i--) {
    const id = scene.order[i]!;
    if (id === skip) continue;
    const s = scene.shapes.get(id);
    if (s && hitShape(s, p, tol)) return id;
  }
  return undefined;
}

/** Ids whose frame lies fully inside `r`, back to front. The marquee's rule: touching is not enough. */
export function inside(scene: Scene, r: Rect): ShapeId[] {
  const ids: ShapeId[] = [];
  for (const id of scene.order) {
    const s = scene.shapes.get(id);
    if (s && contains(r, rectOf(s))) ids.push(id);
  }
  return ids;
}

/** The union of the selected frames, normalized. Undefined for an empty selection. O(selection). */
export function selectionRect(view: Pick<BoardView, "shapes" | "selection">): Rect | undefined {
  let union: Rect | undefined;
  for (const id of view.selection) {
    const s = view.shapes.get(id);
    if (!s) continue;
    const r = rectOf(s);
    union = union
      ? { minX: Math.min(union.minX, r.minX), minY: Math.min(union.minY, r.minY), maxX: Math.max(union.maxX, r.maxX), maxY: Math.max(union.maxY, r.maxY) }
      : r;
  }
  return union;
}

/** See Handles. O(selection). */
export function handlesFor(view: Pick<BoardView, "shapes" | "selection">): Handles {
  const rect = selectionRect(view);
  if (!rect) return { kind: "none" };
  if (view.selection.size === 1) {
    const [id] = view.selection;
    const s = view.shapes.get(id!);
    if (s?.kind === "arrow") return { kind: "arrow", id: s.id, arrow: { x: s.x, y: s.y, w: s.w, h: s.h } };
  }
  let onlyText = true;
  for (const id of view.selection) if (view.shapes.get(id)?.kind !== "text") onlyText = false;
  return { kind: "box", box: boxOf(rect), corners: onlyText, keepAspect: onlyText };
}

/** Handle centers in board space. The painter draws them at HANDLE_PX screen px; handleAt tests the same points. */
export function handlePoints(handles: Handles): ReadonlyArray<readonly [HandleId, Point]> {
  if (handles.kind === "none") return [];
  if (handles.kind === "arrow") {
    const { x, y, w, h } = handles.arrow;
    return [["start", { x, y }], ["end", { x: x + w, y: y + h }]];
  }
  const { x, y, w, h } = handles.box;
  const corners: Array<readonly [HandleId, Point]> = [
    ["nw", { x, y }],
    ["ne", { x: x + w, y }],
    ["se", { x: x + w, y: y + h }],
    ["sw", { x, y: y + h }],
  ];
  if (handles.corners) return corners;
  return [
    ...corners,
    ["n", { x: x + w / 2, y }],
    ["e", { x: x + w, y: y + h / 2 }],
    ["s", { x: x + w / 2, y: y + h }],
    ["w", { x, y: y + h / 2 }],
  ];
}

/** The handle nearest `p` within 3/4 of HANDLE_PX / zoom of it; corners and endpoints win a tie. */
export function handleAt(handles: Handles, p: Point, zoom: number): HandleId | undefined {
  const reach = (HANDLE_PX * 0.75) / zoom;
  let best: HandleId | undefined;
  let bestDistance = reach;
  for (const [id, at] of handlePoints(handles)) {
    const d = Math.max(Math.abs(p.x - at.x), Math.abs(p.y - at.y));
    if (d < bestDistance || (best === undefined && d <= reach)) {
      best = id;
      bestDistance = d;
    }
  }
  return best;
}

export type ResizeMods = { readonly keepAspect: boolean; readonly fromCenter: boolean };

/**
 * The box `from` becomes when `handle` moves by `d` (board units, total since pointer down). It may come back
 * flipped (negative w or h): the model maps flipped boxes and pen points stay inside their frame. A `from` with no
 * width (or no height) keeps none: the model maps it with scale 1.
 */
export function resizeTarget(from: Box, handle: HandleId, d: Point, mods: ResizeMods): Box {
  if (handle === "start") return { x: from.x + d.x, y: from.y + d.y, w: from.w - d.x, h: from.h - d.y };
  if (handle === "end") return { x: from.x, y: from.y, w: from.w + d.x, h: from.h + d.y };

  const moves = { w: handle.includes("w"), e: handle.includes("e"), n: handle.includes("n"), s: handle.includes("s") };
  const edge = (lo: number, hi: number, minus: boolean, plus: boolean, delta: number): [number, number] => {
    if (hi === lo) return [lo, hi];
    if (plus) return [mods.fromCenter ? lo - delta : lo, hi + delta];
    if (minus) return [lo + delta, mods.fromCenter ? hi - delta : hi];
    return [lo, hi];
  };
  let [left, right] = edge(from.x, from.x + from.w, moves.w, moves.e, d.x);
  let [top, bottom] = edge(from.y, from.y + from.h, moves.n, moves.s, d.y);

  if (mods.keepAspect && from.w > 0 && from.h > 0) {
    const sx = (right - left) / from.w;
    const sy = (bottom - top) / from.h;
    const horizontal = moves.w || moves.e;
    const vertical = moves.n || moves.s;
    const k = horizontal && vertical ? Math.max(Math.abs(sx), Math.abs(sy)) : horizontal ? Math.abs(sx) : Math.abs(sy);
    const w = (horizontal ? Math.sign(sx || 1) : 1) * k * from.w;
    const h = (vertical ? Math.sign(sy || 1) : 1) * k * from.h;
    const cx = from.x + from.w / 2;
    const cy = from.y + from.h / 2;
    const anchorX = mods.fromCenter || !horizontal ? cx : moves.e ? from.x : from.x + from.w;
    const anchorY = mods.fromCenter || !vertical ? cy : moves.s ? from.y : from.y + from.h;
    left = anchorX + (from.x - anchorX) * (w / from.w);
    right = anchorX + (from.x + from.w - anchorX) * (w / from.w);
    top = anchorY + (from.y - anchorY) * (h / from.h);
    bottom = anchorY + (from.y + from.h - anchorY) * (h / from.h);
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/**
 * The frame a box tool draws from pointer-down `a` to the pointer `b`. `square` forces |w| = |h|, keeping the signs;
 * for an arrow it snaps the angle to 15 degrees instead. An arrow's direction is in the signs of w and h.
 */
export function dragFrame(kind: "rect" | "ellipse" | "diamond" | "arrow", a: Point, b: Point, square: boolean): Box {
  const w = b.x - a.x;
  const h = b.y - a.y;
  if (!square) return { x: a.x, y: a.y, w, h };
  if (kind === "arrow") {
    const step = Math.PI / 12;
    const angle = Math.round(Math.atan2(h, w) / step) * step;
    const length = Math.hypot(w, h);
    return { x: a.x, y: a.y, w: length * Math.cos(angle), h: length * Math.sin(angle) };
  }
  const side = Math.max(Math.abs(w), Math.abs(h));
  return { x: a.x, y: a.y, w: Math.sign(w || 1) * side, h: Math.sign(h || 1) * side };
}

/** The union of every frame, for fit-to-content. O(n). Undefined on an empty board. */
export function contentRect(scene: Scene): Rect | undefined {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of scene.order) {
    const s = scene.shapes.get(id);
    if (!s) continue;
    minX = Math.min(minX, s.x, s.x + s.w);
    minY = Math.min(minY, s.y, s.y + s.h);
    maxX = Math.max(maxX, s.x, s.x + s.w);
    maxY = Math.max(maxY, s.y, s.y + s.h);
  }
  return minX === Infinity ? undefined : { minX, minY, maxX, maxY };
}

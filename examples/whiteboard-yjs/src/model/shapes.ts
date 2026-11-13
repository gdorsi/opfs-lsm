import { isZ } from "./zorder.ts";
import type { BoardId, NewShape, Point, Shape, ShapeId, Style } from "./types.ts";

export const shapeId = (value: string): ShapeId => value as ShapeId;
export const boardId = (value: string): BoardId => value as BoardId;

const POINT_MAX = 65535;

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * The boundary between stored records and the model: undefined for anything the model could not have written.
 * `raw` is the plain object of one shape's fields.
 */
export function parseShape(id: ShapeId, raw: unknown): Shape | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const { kind, x, y, w, h, z, stroke, fill, strokeWidth } = r;
  if (!isNumber(x) || !isNumber(y) || !isNumber(w) || !isNumber(h) || !isNumber(strokeWidth)) return undefined;
  if (typeof stroke !== "string" || !(typeof fill === "string" || fill === null) || !isZ(z)) return undefined;
  const common = { id, x, y, w, h, z, stroke, fill, strokeWidth };
  switch (kind) {
    case "rect":
    case "ellipse":
    case "diamond":
    case "arrow":
      return { ...common, kind };
    case "text":
      return typeof r.text === "string" && isNumber(r.fontSize)
        ? { ...common, kind, text: r.text, fontSize: r.fontSize }
        : undefined;
    case "pen":
      return isPoints(r.points) ? { ...common, kind, points: r.points } : undefined;
    default:
      return undefined;
  }
}

function isPoints(value: unknown): value is number[] {
  if (!Array.isArray(value) || value.length % 2 !== 0) return false;
  return value.every((n) => Number.isInteger(n) && n >= 0 && n <= POINT_MAX);
}

/** A pen stroke from points in board coordinates: the frame is their bounds, the points are stored relative to it. */
export function penShape(points: readonly Point[], style: Style): NewShape {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const w = maxX - minX;
  const h = maxY - minY;
  const flat: number[] = [];
  for (const p of points) {
    flat.push(w === 0 ? 0 : Math.round(((p.x - minX) / w) * POINT_MAX));
    flat.push(h === 0 ? 0 : Math.round(((p.y - minY) / h) * POINT_MAX));
  }
  return { kind: "pen", x: minX, y: minY, w, h, points: flat, ...style };
}

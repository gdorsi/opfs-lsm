import { penShape } from "../../src/model/shapes.ts";
import type { Box, Command, NewShape, Point, Shape, ShapeId } from "../../src/model/types.ts";
import type { Scene } from "../../src/model/plan.ts";
import { int, pick, type Rng } from "./rng.ts";
import { sid } from "./scenes.ts";

const COLORS = ["#111", "#d33", "#2a6", "#36c", "#fa0"];
const WORDS = ["héllo", "tab\tbed", "日本語", "line\nbreak", "", "emoji ✓"];

const coord = (rng: Rng) => Math.round(rng() * 200000 - 100000) / 100;
const style = (rng: Rng) => ({
  stroke: pick(rng, COLORS),
  fill: rng() < 0.4 ? null : pick(rng, COLORS),
  strokeWidth: pick(rng, [1, 2, 4, 0.5]),
});

function randomShape(rng: Rng): NewShape {
  const frame = { x: coord(rng), y: coord(rng), w: int(rng, -300, 300) + rng(), h: int(rng, -300, 300) + rng() };
  switch (pick(rng, ["rect", "ellipse", "diamond", "text", "arrow", "pen"] as const)) {
    case "text":
      return { kind: "text", ...frame, ...style(rng), text: pick(rng, WORDS), fontSize: int(rng, 8, 72) };
    case "pen": {
      const points: Point[] = Array.from({ length: int(rng, 1, 40) }, () => ({ x: coord(rng), y: coord(rng) }));
      return penShape(points, style(rng));
    }
    case "arrow":
      return { kind: "arrow", ...frame, ...style(rng) };
    case "ellipse":
      return { kind: "ellipse", ...frame, ...style(rng) };
    case "diamond":
      return { kind: "diamond", ...frame, ...style(rng) };
    default:
      return { kind: "rect", ...frame, ...style(rng) };
  }
}

function boundsOf(shapes: readonly Shape[]): Box {
  const xs = shapes.flatMap((s) => [s.x, s.x + s.w]);
  const ys = shapes.flatMap((s) => [s.y, s.y + s.h]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** A command that is valid for the scene, sometimes naming an id that does not exist. */
export function randomCommand(rng: Rng, scene: Scene): Command {
  const count = scene.order.length;
  if (count < 3) return { type: "create", shapes: Array.from({ length: int(rng, 1, 4) }, () => randomShape(rng)) };
  const ids: ShapeId[] = Array.from({ length: int(rng, 1, Math.min(6, count)) }, () => pick(rng, scene.order));
  if (rng() < 0.05) ids.push(sid("ghost"));
  const chosen = ids.flatMap((id) => scene.shapes.get(id) ?? []);
  const roll = rng() * (count > 40 ? 110 : 100);
  if (roll < 15) return { type: "create", shapes: Array.from({ length: int(rng, 1, 5) }, () => randomShape(rng)) };
  if (roll < 40) return { type: "move", ids, dx: int(rng, -50, 50) + rng(), dy: rng() < 0.2 ? 0 : int(rng, -50, 50) };
  if (roll < 50 && chosen.length > 0) {
    const from = boundsOf(chosen);
    const flip = rng() < 0.2 ? -1 : 1;
    const to = {
      x: from.x + int(rng, -40, 40),
      y: from.y + int(rng, -40, 40),
      w: from.w * (0.25 + rng() * 2),
      h: from.h * flip * (0.25 + rng() * 2),
    };
    return { type: "resize", ids, from, to };
  }
  if (roll < 65) {
    const edit = pick(rng, [
      { stroke: pick(rng, COLORS) },
      { fill: rng() < 0.3 ? null : pick(rng, COLORS) },
      { strokeWidth: pick(rng, [1, 2, 4]) },
      { text: pick(rng, WORDS), fontSize: int(rng, 8, 72) },
    ]);
    return { type: "style", ids, edit };
  }
  if (roll < 80) return { type: "reorder", ids, to: pick(rng, ["front", "back", "forward", "backward"] as const) };
  if (roll < 85) return { type: "duplicate", ids, dx: int(rng, -30, 30), dy: int(rng, -30, 30) };
  return { type: "remove", ids };
}

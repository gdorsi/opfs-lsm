import { penShape } from "./shapes.ts";
import type { NewShape, Point } from "./types.ts";

type Rng = () => number;

const WORLD = 20_000;
const COLORS = ["#111111", "#d33333", "#22aa66", "#3366cc", "#ffaa00"];

const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)]!;
const between = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));

const style = (rng: Rng) => ({
  stroke: pick(rng, COLORS),
  fill: rng() < 0.4 ? null : pick(rng, COLORS),
  strokeWidth: pick(rng, [1, 2, 4]),
});

/** A shape somewhere on a 20,000-unit square: 40% boxes, 15% text, 15% arrows, 30% pen strokes of 5 to 60 points. */
export function scatterShape(rng: Rng): NewShape {
  const frame = { x: between(rng, 0, WORLD), y: between(rng, 0, WORLD), w: between(rng, 20, 300), h: between(rng, 20, 200) };
  const roll = rng();
  if (roll < 0.4) return { kind: pick(rng, ["rect", "ellipse", "diamond"] as const), ...frame, ...style(rng) };
  if (roll < 0.55) return { kind: "text", ...frame, ...style(rng), text: `note ${between(rng, 0, 9999)}`, fontSize: pick(rng, [12, 16, 24]) };
  if (roll < 0.7) return { kind: "arrow", ...frame, ...style(rng) };
  const points: Point[] = [];
  let at = { x: frame.x, y: frame.y };
  for (let i = between(rng, 5, 60); i > 0; i--) {
    at = { x: at.x + between(rng, -12, 12), y: at.y + between(rng, -12, 12) };
    points.push(at);
  }
  return penShape(points, style(rng));
}

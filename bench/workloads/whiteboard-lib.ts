/**
 * Shared by the whiteboard workloads: a seeded Env, scripted shapes, commands and pointer paths, and the
 * pacing of a pointer at display rate. Everything draws from `ctx.rng`, so every contender replays the same ops.
 */
import { penShape, type Command, type Env, type NewShape, type Point, type Shape, type ShapeId } from "@opfs-lsm/example-whiteboard-yjs/model";
import { yieldTask } from "../page/main-thread.ts";

const POINTER_HZ = 120;
export const FRAME_MS = 1000 / POINTER_HZ;
export const EVENTS_PER_DRAG = 120;
export const EVENTS_PER_LASSO_DRAG = 60;
export const LASSO = 200;
const WORLD = 20_000;
const COLORS = ["#111111", "#d33333", "#22aa66", "#3366cc", "#ffaa00"];

type Rng = () => number;
export const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)]!;
const between = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));

/** Ids come from the seeded rng and `now` counts up, so no run depends on the clock. Nothing schedules: the bench flushes itself. */
export function seededEnv(rng: Rng): Env {
  let clock = 1_700_000_000_000;
  return {
    id() {
      let id = "";
      while (id.length < 12) id += Math.floor(rng() * 36 ** 6).toString(36).padStart(6, "0");
      return id.slice(0, 12);
    },
    now: () => ++clock,
    schedule: () => () => {},
  };
}

const style = (rng: Rng) => ({
  stroke: pick(rng, COLORS),
  fill: rng() < 0.4 ? null : pick(rng, COLORS),
  strokeWidth: pick(rng, [1, 2, 4]),
});

/** A mix of the six kinds: mostly boxes, some text, arrows and pen strokes of 5 to 60 points. */
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

/** The total offset from pointer down at each event: a steady pull with a wobble, as absolute targets. */
export function pointerPath(rng: Rng, events: number): { dx: number; dy: number }[] {
  const toX = between(rng, -600, 600);
  const toY = between(rng, -400, 400);
  return Array.from({ length: events }, (_, i) => {
    const k = (i + 1) / events;
    return { dx: Math.round(toX * k + between(rng, -3, 3)), dy: Math.round(toY * k + between(rng, -3, 3)) };
  });
}

/** One edit of a person working on a board that already has shapes, drawn from `shapes`. */
export function editCommand(rng: Rng, shapes: ReadonlyMap<ShapeId, Shape>): Command {
  const all = [...shapes.keys()];
  const some = (max: number) => Array.from({ length: between(rng, 1, Math.min(max, all.length)) }, () => pick(rng, all));
  const roll = rng();
  if (all.length < 5 || roll < 0.05) return { type: "create", shapes: [scatterShape(rng)] };
  if (roll < 0.4) return { type: "style", ids: some(3), edit: rng() < 0.5 ? { stroke: pick(rng, COLORS) } : { strokeWidth: pick(rng, [1, 2, 4, 8]) } };
  if (roll < 0.65) return { type: "move", ids: some(5), dx: between(rng, -80, 80), dy: between(rng, -80, 80) };
  if (roll < 0.8) return { type: "reorder", ids: some(3), to: pick(rng, ["front", "back", "forward", "backward"] as const) };
  if (roll < 0.9) return { type: "duplicate", ids: some(2), dx: 20, dy: 20 };
  return { type: "remove", ids: some(1) };
}

/** Waits until `deadline` (performance.now). A task is yielded either way, so the page can paint between events. */
export async function paceTo(deadline: number): Promise<void> {
  const wait = deadline - performance.now();
  if (wait > 2) await new Promise<void>((resolve) => setTimeout(resolve, wait - 1));
  else await yieldTask();
}

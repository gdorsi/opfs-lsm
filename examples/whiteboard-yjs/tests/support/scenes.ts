import { applyPatchPlain } from "../../src/model/digest.ts";
import { shapeId } from "../../src/model/shapes.ts";
import type { Patch, Shape, ShapeId, Z } from "../../src/model/types.ts";
import type { Scene } from "../../src/model/plan.ts";

export const sid = shapeId;

const base = { x: 0, y: 0, w: 10, h: 10, stroke: "#000", fill: null, strokeWidth: 2 };

/** A shape fixture. `z` is a fractional-indexing key such as "a0" < "a1" < "a2". */
export function shape(id: string, z: string, over: Record<string, unknown> = {}): Shape {
  const kind = (over.kind as string | undefined) ?? "rect";
  const extra = kind === "text" ? { text: "hi", fontSize: 16 } : kind === "pen" ? { points: [0, 0, 65535, 65535] } : {};
  return { ...base, ...extra, ...over, kind, id: sid(id), z: z as Z } as Shape;
}

/** (z, id) order, written out here so no test leans on the model's comparator. */
export function sortedIds(shapes: Iterable<Shape>): ShapeId[] {
  return [...shapes]
    .sort((a, b) => (a.z < b.z ? -1 : a.z > b.z ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((s) => s.id);
}

export function sceneOf(...shapes: Shape[]): Scene {
  return { shapes: new Map(shapes.map((s) => [s.id, s])), order: sortedIds(shapes) };
}

/** The scene after `patch`, by the oracle. */
export function after(scene: Scene, patch: Patch): Scene {
  const shapes = new Map(scene.shapes);
  applyPatchPlain(shapes, patch);
  return { shapes, order: sortedIds(shapes.values()) };
}

export function counter(prefix = "n"): () => ShapeId {
  let n = 0;
  return () => sid(`${prefix}${++n}`);
}

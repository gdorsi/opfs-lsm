import type { Patch, Shape, ShapeId, Shapes } from "./types.ts";

/** The oracle: replays a patch on a plain Map. It knows nothing of Yjs or storage. */
export function applyPatchPlain(shapes: Map<ShapeId, Shape>, patch: Patch): void {
  for (const [id, entry] of patch) {
    if (entry.op === "put") shapes.set(id, entry.shape);
    else if (entry.op === "del") shapes.delete(id);
    else {
      const shape = shapes.get(id);
      if (shape) shapes.set(id, { ...shape, ...entry.edit } as Shape);
    }
  }
}

/** "count:hash": FNV-1a over every field of every shape, sorted by id. Any lost, duplicated or changed field shows. */
export function digestShapes(shapes: Shapes): string {
  let hash = 0x811c9dc5;
  for (const id of [...shapes.keys()].sort()) {
    const text = canonical(shapes.get(id)!) + "\n";
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  }
  return `${shapes.size}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function canonical(s: Shape): string {
  const extra = s.kind === "text" ? [s.text, s.fontSize] : s.kind === "pen" ? s.points : null;
  return JSON.stringify([s.id, s.kind, s.x, s.y, s.w, s.h, s.z, s.stroke, s.fill, s.strokeWidth, extra]);
}

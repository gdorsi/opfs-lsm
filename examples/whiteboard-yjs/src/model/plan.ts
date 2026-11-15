import { rekey, zInFront } from "./zorder.ts";
import type { Applied, BoardView, Box, Command, Direction, Patch, PatchEntry, Shape, ShapeEdit, ShapeId } from "./types.ts";

export type Scene = Pick<BoardView, "shapes" | "order">;

/** What `command` does to `scene`, as a patch. The only place that knows what a command means. Pure. */
export function plan(scene: Scene, command: Command, newId: () => ShapeId): Patch {
  const patch = new Map<ShapeId, PatchEntry>();
  const present = (ids: readonly ShapeId[]) => new Set(ids.filter((id) => scene.shapes.has(id)));

  switch (command.type) {
    case "create": {
      const keys = zInFront(topZ(scene), command.shapes.length);
      command.shapes.forEach((shape, i) => {
        const id = newId();
        patch.set(id, { op: "put", shape: { ...shape, id, z: keys[i]! } as Shape });
      });
      break;
    }
    case "move":
      for (const id of present(command.ids)) {
        const s = scene.shapes.get(id)!;
        setChanged(patch, s, { x: s.x + command.dx, y: s.y + command.dy });
      }
      break;
    case "resize":
      for (const id of present(command.ids)) {
        const s = scene.shapes.get(id)!;
        setChanged(patch, s, mapBox(s, command.from, command.to));
      }
      break;
    case "style": {
      const { text, fontSize, ...style } = command.edit;
      for (const id of present(command.ids)) {
        const s = scene.shapes.get(id)!;
        setChanged(patch, s, s.kind === "text" ? { ...style, text, fontSize } : style);
      }
      break;
    }
    case "reorder":
      reorder(scene, patch, present(command.ids), command.to);
      break;
    case "duplicate": {
      const picked = new Set(command.ids);
      const sources = scene.order.filter((id) => picked.has(id));
      const keys = zInFront(topZ(scene), sources.length);
      sources.forEach((source, i) => {
        const s = scene.shapes.get(source)!;
        const id = newId();
        patch.set(id, { op: "put", shape: { ...s, id, z: keys[i]!, x: s.x + command.dx, y: s.y + command.dy } });
      });
      break;
    }
    case "remove":
      for (const id of present(command.ids)) patch.set(id, { op: "del" });
      break;
  }
  return patch;
}

/** A patch with the ids it made, in patch order. */
export function toApplied(patch: Patch): Applied {
  const created: ShapeId[] = [];
  for (const [id, entry] of patch) if (entry.op === "put") created.push(id);
  return { patch, created };
}

export function topZ(scene: Scene) {
  const top = scene.order[scene.order.length - 1];
  return top === undefined ? undefined : scene.shapes.get(top)!.z;
}

function mapBox(s: Box, from: Box, to: Box): Box {
  const sx = from.w === 0 ? 1 : to.w / from.w;
  const sy = from.h === 0 ? 1 : to.h / from.h;
  return { x: to.x + (s.x - from.x) * sx, y: to.y + (s.y - from.y) * sy, w: s.w * sx, h: s.h * sy };
}

/** Sets only the fields of `next` that differ from the shape. Writes nothing when none do. */
function setChanged(patch: Map<ShapeId, PatchEntry>, shape: Shape, next: ShapeEdit): void {
  let edit: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(next)) {
    if (value !== undefined && (shape as Record<string, unknown>)[key] !== value) (edit ??= {})[key] = value;
  }
  if (edit) patch.set(shape.id, { op: "set", edit: edit as ShapeEdit });
}

function reorder(scene: Scene, patch: Map<ShapeId, PatchEntry>, picked: ReadonlySet<ShapeId>, to: Direction): void {
  const target = reordered(scene.order, picked, to);
  if (target.every((id, i) => id === scene.order[i])) return;
  const keys = rekey(target, picked, (id) => scene.shapes.get(id)!.z);
  for (const [id, z] of keys) setChanged(patch, scene.shapes.get(id)!, { z });
}

function reordered(order: readonly ShapeId[], picked: ReadonlySet<ShapeId>, to: Direction): ShapeId[] {
  const rest = order.filter((id) => !picked.has(id));
  const chosen = order.filter((id) => picked.has(id));
  if (to === "front") return [...rest, ...chosen];
  if (to === "back") return [...chosen, ...rest];
  const next = [...order];
  if (to === "forward") {
    for (let i = next.length - 2; i >= 0; i--) {
      if (picked.has(next[i]!) && !picked.has(next[i + 1]!)) [next[i], next[i + 1]] = [next[i + 1]!, next[i]!];
    }
  } else {
    for (let i = 1; i < next.length; i++) {
      if (picked.has(next[i]!) && !picked.has(next[i - 1]!)) [next[i], next[i - 1]] = [next[i - 1]!, next[i]!];
    }
  }
  return next;
}

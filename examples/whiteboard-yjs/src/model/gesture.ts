import { plan, topZ, type Scene } from "./plan.ts";
import { penShape } from "./shapes.ts";
import { zInFront } from "./zorder.ts";
import type {
  Command,
  GestureInput,
  GestureStart,
  Patch,
  PatchEntry,
  Point,
  Shape,
  ShapeEdit,
  ShapeId,
  Style,
  Z,
} from "./types.ts";

type Kind = GestureStart["kind"];

/**
 * What one kind of gesture shows, stores and returns. Pure: it never touches the doc, the view or the clock, so the
 * board decides when to write. Every patch it makes is against the shapes at pointer down, with absolute targets.
 */
export interface Track<K extends Kind> {
  /** Takes the input of the latest pointer event. */
  aim(input: GestureInput[K]): void;
  /** The shapes the view shows for the latest aim. */
  shown(scene: Scene): Shape[];
  /** The patch that brings the stored shapes to the latest aim, remembered as stored. Empty when they are there. */
  due(scene: Scene): Patch;
  /** The gesture as one patch against its start (`net`), and what is still to store to get there (`rest`). */
  finish(scene: Scene): { net: Patch; rest: Patch };
  /** The ids the gesture has laid over the view, for the board to re-read when the gesture is cancelled. */
  touched(): Iterable<ShapeId>;
}

const NOTHING: Patch = new Map();

/** Makes the track for a gesture. The cast is the one place a kind meets its input type. */
export function trackFor<K extends Kind>(
  start: Extract<GestureStart, { kind: K }>,
  scene: Scene,
  newId: () => ShapeId,
): Track<K> {
  const s: GestureStart = start;
  switch (s.kind) {
    case "translate":
      return new Drag<"translate">(scene, s.ids, ({ dx, dy }) => ({ type: "move", ids: s.ids, dx, dy })) as Track<K>;
    case "resize":
      return new Drag<"resize">(scene, s.ids, ({ to }) => ({ type: "resize", ids: s.ids, from: s.from, to })) as Track<K>;
    case "draw":
      return new Draw(s.style, newId) as Track<K>;
  }
}

const FRAME = ["x", "y", "w", "h"] as const;

/** Moves or resizes shapes. Their frames are all it ever sets. */
class Drag<K extends "translate" | "resize"> implements Track<K> {
  private readonly start = new Map<ShapeId, Shape>();
  private readonly startScene: Scene;
  private readonly command: (input: GestureInput[K]) => Command;
  private aimed: Patch = NOTHING;
  private stored: Patch = NOTHING;

  constructor(scene: Scene, ids: readonly ShapeId[], command: (input: GestureInput[K]) => Command) {
    this.command = command;
    for (const id of ids) {
      const shape = scene.shapes.get(id);
      if (shape) this.start.set(id, shape);
    }
    this.startScene = { shapes: this.start, order: [...this.start.keys()] };
  }

  aim(input: GestureInput[K]): void {
    this.aimed = plan(this.startScene, this.command(input), unreachable);
  }

  shown(scene: Scene): Shape[] {
    const shapes: Shape[] = [];
    for (const [id, start] of this.start) {
      const now = scene.shapes.get(id);
      if (!now) continue;
      const edit = editOf(this.aimed, id);
      shapes.push({ ...now, x: edit.x ?? start.x, y: edit.y ?? start.y, w: edit.w ?? start.w, h: edit.h ?? start.h });
    }
    return shapes;
  }

  due(scene: Scene): Patch {
    const patch = new Map<ShapeId, PatchEntry>();
    for (const [id, start] of this.start) {
      if (!scene.shapes.has(id)) continue;
      const to = editOf(this.aimed, id);
      const from = editOf(this.stored, id);
      let edit: Record<string, number> | undefined;
      for (const key of FRAME) {
        const value = to[key] ?? start[key];
        if (value !== (from[key] ?? start[key])) (edit ??= {})[key] = value;
      }
      if (edit) patch.set(id, { op: "set", edit: edit as ShapeEdit });
    }
    this.stored = this.aimed;
    return patch;
  }

  finish(scene: Scene): { net: Patch; rest: Patch } {
    const rest = this.due(scene);
    const net = new Map<ShapeId, PatchEntry>();
    for (const [id, entry] of this.aimed) if (scene.shapes.has(id)) net.set(id, entry);
    return { net, rest };
  }

  touched(): Iterable<ShapeId> {
    return this.start.keys();
  }
}

const editOf = (patch: Patch, id: ShapeId): ShapeEdit => {
  const entry = patch.get(id);
  return entry?.op === "set" ? entry.edit : {};
};

const unreachable = (): ShapeId => {
  throw new Error("a drag creates no shape");
};

/** Draws a stroke. The doc sees nothing until pen up, then one `put`. */
class Draw implements Track<"draw"> {
  private readonly points: Point[] = [];
  private readonly style: Style;
  private readonly newId: () => ShapeId;
  private id: ShapeId | undefined;
  private z: Z | undefined;

  constructor(style: Style, newId: () => ShapeId) {
    this.style = style;
    this.newId = newId;
  }

  aim(point: Point): void {
    this.id ??= this.newId();
    this.points.push(point);
  }

  shown(scene: Scene): Shape[] {
    if (this.id === undefined) return [];
    this.z ??= zInFront(topZ(scene), 1)[0]!;
    return [{ ...penShape(this.points, this.style), id: this.id, z: this.z } as Shape];
  }

  due(): Patch {
    return NOTHING;
  }

  finish(scene: Scene): { net: Patch; rest: Patch } {
    if (this.id === undefined) return { net: NOTHING, rest: NOTHING };
    const id = this.id;
    const last = scene.order[scene.order.length - 1];
    const order = last === id ? scene.order.slice(0, -1) : scene.order;
    const net = plan({ shapes: scene.shapes, order }, { type: "create", shapes: [penShape(this.points, this.style)] }, () => id);
    return { net, rest: net };
  }

  touched(): Iterable<ShapeId> {
    return this.id === undefined ? [] : [this.id];
  }
}

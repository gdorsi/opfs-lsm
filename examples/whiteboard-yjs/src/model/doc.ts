import * as Y from "yjs";
import { parseShape } from "./shapes.ts";
import type { Patch, Shape, ShapeId } from "./types.ts";

// Board doc: a top-level Y.Map "shapes", ShapeId -> Y.Map of fields. One Y.Map per shape and one key per field,
// so a move and a restyle of one shape merge. The id is the key and is not stored again. z is a field.
const SHAPES = "shapes";

export type Read = Shape | "absent" | "bad";

export const shapesOf = (doc: Y.Doc): Y.Map<Y.Map<unknown>> => doc.getMap<Y.Map<unknown>>(SHAPES);

/** One Y transaction, so one Yjs update. */
export function applyPatch(doc: Y.Doc, patch: Patch, origin: unknown): void {
  const shapes = shapesOf(doc);
  doc.transact(() => {
    for (const [id, entry] of patch) {
      if (entry.op === "put") {
        shapes.set(id, new Y.Map(Object.entries(entry.shape).filter(([key]) => key !== "id")));
      } else if (entry.op === "del") {
        shapes.delete(id);
      } else {
        const fields = shapes.get(id);
        if (fields) for (const [key, value] of Object.entries(entry.edit)) if (value !== undefined) fields.set(key, value);
      }
    }
  }, origin);
}

export function readShape(doc: Y.Doc, id: ShapeId): Read {
  const fields = shapesOf(doc).get(id);
  if (fields === undefined) return "absent";
  return parseShape(id, fields instanceof Y.Map ? fields.toJSON() : undefined) ?? "bad";
}

export function readShapes(doc: Y.Doc): { shapes: Map<ShapeId, Shape>; bad: Set<ShapeId> } {
  const shapes = new Map<ShapeId, Shape>();
  const bad = new Set<ShapeId>();
  shapesOf(doc).forEach((fields, key) => {
    const id = key as ShapeId;
    const shape = parseShape(id, fields instanceof Y.Map ? fields.toJSON() : undefined);
    if (shape) shapes.set(id, shape);
    else bad.add(id);
  });
  return { shapes, bad };
}

/** Calls `onChange` once per transaction with the ids of the shapes it touched. Returns the unsubscribe. */
export function watch(doc: Y.Doc, onChange: (ids: ReadonlySet<ShapeId>) => void): () => void {
  const shapes = shapesOf(doc);
  const handler = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
    const ids = new Set<ShapeId>();
    for (const event of events) {
      if (event.target !== shapes) ids.add(event.path[0] as ShapeId);
      else if (event instanceof Y.YMapEvent) for (const key of event.keysChanged) ids.add(key as ShapeId);
    }
    onChange(ids);
  };
  shapes.observeDeep(handler);
  return () => shapes.unobserveDeep(handler);
}

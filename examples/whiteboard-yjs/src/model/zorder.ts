import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";
import type { ShapeId, Z } from "./types.ts";

/** Back to front: by key, then by id. */
export function byZ(a: { readonly z: Z; readonly id: ShapeId }, b: { readonly z: Z; readonly id: ShapeId }): number {
  if (a.z !== b.z) return a.z < b.z ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

export function isZ(value: unknown): value is Z {
  if (typeof value !== "string") return false;
  try {
    generateKeyBetween(value, null);
    return true;
  } catch {
    return false;
  }
}

/** `count` keys in front of `top`, in ascending order. */
export function zInFront(top: Z | undefined, count: number): Z[] {
  return generateNKeysBetween(top ?? null, null, count) as Z[];
}

/**
 * New keys that put the `moved` ids where `target` (back to front) has them, leaving every other key alone.
 * Equal keys cannot be split, so a run that would land between two of them lands after them.
 */
export function rekey(target: readonly ShapeId[], moved: ReadonlySet<ShapeId>, zOf: (id: ShapeId) => Z): Map<ShapeId, Z> {
  const keys = new Map<ShapeId, Z>();
  let floor: Z | null = null;
  let i = 0;
  while (i < target.length) {
    const id = target[i]!;
    if (!moved.has(id)) {
      const z = zOf(id);
      if (floor === null || z > floor) floor = z;
      i++;
      continue;
    }
    let end = i;
    while (end < target.length && moved.has(target[end]!)) end++;
    let ceiling: Z | null = null;
    for (let k = end; k < target.length; k++) {
      const z = moved.has(target[k]!) ? null : zOf(target[k]!);
      if (z !== null && (floor === null || z > floor)) {
        ceiling = z;
        break;
      }
    }
    const run = generateNKeysBetween(floor, ceiling, end - i) as Z[];
    for (let k = i; k < end; k++) keys.set(target[k]!, run[k - i]!);
    floor = run[run.length - 1]!;
    i = end;
  }
  return keys;
}

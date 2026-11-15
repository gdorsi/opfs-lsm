import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { applyPatchPlain, digestShapes } from "../src/model/digest.ts";
import type { Patch, PatchEntry, Shape, ShapeId } from "../src/model/types.ts";
import { shape, sid } from "./support/scenes.ts";

const mapOf = (...shapes: Shape[]) => new Map(shapes.map((s) => [s.id, s]));

describe("digestShapes", () => {
  test("does not depend on the order shapes were added", () => {
    const [a, b, c] = [shape("a", "a0"), shape("b", "a1"), shape("c", "a2")];
    assert.equal(digestShapes(mapOf(a, b, c)), digestShapes(mapOf(c, a, b)));
  });

  test("counts the shapes", () => {
    assert.match(digestShapes(mapOf()), /^0:/);
    assert.match(digestShapes(mapOf(shape("a", "a0"), shape("b", "a1"))), /^2:/);
  });

  const kinds = ["rect", "ellipse", "diamond", "arrow", "text", "pen"];
  for (const kind of kinds) {
    test(`sees a change to any field of a ${kind}`, () => {
      const base = shape("a", "a0", { kind });
      const baseline = digestShapes(mapOf(base));
      const changes: Record<string, unknown> = {
        x: 1,
        y: 1,
        w: 11,
        h: 11,
        z: "a1",
        stroke: "#fff",
        fill: "#fff",
        strokeWidth: 3,
        id: "other",
        ...(kind === "text" ? { text: "bye", fontSize: 17 } : {}),
        ...(kind === "pen" ? { points: [0, 0, 65535, 65534] } : {}),
      };
      for (const [field, value] of Object.entries(changes)) {
        const changed = { ...base, [field]: value } as Shape;
        assert.notEqual(digestShapes(mapOf(changed)), baseline, `${field} is not in the digest`);
      }
    });
  }

  test("tells a missing fill from an empty string", () => {
    const none = digestShapes(mapOf(shape("a", "a0", { fill: null })));
    assert.notEqual(none, digestShapes(mapOf(shape("a", "a0", { fill: "" }))));
  });

  test("tells one shape from two halves of it", () => {
    assert.notEqual(digestShapes(mapOf(shape("a", "a0"))), digestShapes(mapOf(shape("a", "a0"), shape("b", "a0"))));
  });
});

describe("applyPatchPlain", () => {
  const entries = (...pairs: [string, PatchEntry][]): Patch => new Map(pairs.map(([id, entry]) => [sid(id), entry]));

  test("puts, sets and deletes", () => {
    const shapes = new Map<ShapeId, Shape>([[sid("a"), shape("a", "a0")]]);
    applyPatchPlain(
      shapes,
      entries(["b", { op: "put", shape: shape("b", "a1") }], ["a", { op: "set", edit: { x: 9, fill: "#f00" } }]),
    );
    assert.deepEqual([...shapes.keys()], ["a", "b"]);
    assert.deepEqual([shapes.get(sid("a"))!.x, shapes.get(sid("a"))!.fill], [9, "#f00"]);
    applyPatchPlain(shapes, entries(["a", { op: "del" }]));
    assert.deepEqual([...shapes.keys()], ["b"]);
  });

  test("drops a set on a shape that is gone", () => {
    const shapes = new Map<ShapeId, Shape>();
    applyPatchPlain(shapes, entries(["a", { op: "set", edit: { x: 1 } }]));
    assert.equal(shapes.size, 0);
  });
});

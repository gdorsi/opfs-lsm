import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ShapeId } from "../../src/model/types.ts";
import {
  boxOf,
  dragFrame,
  handleAt,
  handlesFor,
  hitShape,
  hitTop,
  inside,
  rectOf,
  resizeTarget,
  type Handles,
} from "../../src/app/core/geometry.ts";
import { sceneOf, shape, sid } from "../support/scenes.ts";

const NONE = { keepAspect: false, fromCenter: false };
const at = (x: number, y: number) => ({ x, y });

describe("rectOf", () => {
  test("normalizes negative w and h", () => {
    assert.deepEqual(rectOf({ x: 10, y: 10, w: -4, h: -6 }), { minX: 6, minY: 4, maxX: 10, maxY: 10 });
  });
});

describe("hitShape", () => {
  const frame = { x: 0, y: 0, w: 100, h: 60 };

  test("a filled rect is hit inside, an unfilled one only on its border", () => {
    const filled = shape("r", "a0", { ...frame, fill: "#f00" });
    const hollow = shape("r", "a0", frame);
    assert.equal(hitShape(filled, at(50, 30), 1), true);
    assert.equal(hitShape(hollow, at(50, 30), 1), false, "the middle of an unfilled rect");
    assert.equal(hitShape(hollow, at(0, 30), 1), true, "its left border");
    assert.equal(hitShape(hollow, at(101, 30), 1), true, "within tolerance of the border");
    assert.equal(hitShape(hollow, at(120, 30), 1), false);
  });

  test("ellipse: inside when filled, on the boundary within tolerance when not", () => {
    const filled = shape("e", "a0", { kind: "ellipse", ...frame, fill: "#f00" });
    const hollow = shape("e", "a0", { kind: "ellipse", ...frame });
    assert.equal(hitShape(filled, at(50, 30), 1), true);
    assert.equal(hitShape(hollow, at(50, 30), 1), false);
    assert.equal(hitShape(hollow, at(100, 30), 1), true, "the right-most point");
    assert.equal(hitShape(hollow, at(2, 2), 1), false, "the corner of the frame is outside the ellipse");
  });

  test("a zero-radius ellipse acts as a segment", () => {
    const line = shape("e", "a0", { kind: "ellipse", x: 10, y: 0, w: 0, h: 40 });
    assert.equal(hitShape(line, at(10, 20), 1), true);
    assert.equal(hitShape(line, at(30, 20), 1), false);
  });

  test("diamond: inside when filled, near an edge when not", () => {
    const filled = shape("d", "a0", { kind: "diamond", ...frame, fill: "#f00" });
    const hollow = shape("d", "a0", { kind: "diamond", ...frame });
    assert.equal(hitShape(filled, at(50, 30), 1), true);
    assert.equal(hitShape(filled, at(5, 5), 1), false, "the frame's corner is outside the diamond");
    assert.equal(hitShape(hollow, at(50, 30), 1), false);
    assert.equal(hitShape(hollow, at(25, 15), 1), true, "the middle of the top-left edge");
  });

  test("arrow: near the segment, flipped boxes included", () => {
    const arrow = shape("a", "a0", { kind: "arrow", x: 100, y: 100, w: -100, h: -50 });
    assert.equal(hitShape(arrow, at(50, 75), 1), true);
    assert.equal(hitShape(arrow, at(50, 90), 1), false);
  });

  test("pen: near a segment between decoded points, and a single point is a dot", () => {
    const pen = shape("p", "a0", { kind: "pen", x: 0, y: 0, w: 100, h: 100, points: [0, 0, 65535, 65535] });
    assert.equal(hitShape(pen, at(50, 50), 1), true);
    assert.equal(hitShape(pen, at(80, 20), 1), false);
    const dot = shape("p", "a0", { kind: "pen", x: 10, y: 10, w: 0, h: 0, points: [0, 0] });
    assert.equal(hitShape(dot, at(10, 10), 1), true);
    assert.equal(hitShape(dot, at(20, 10), 1), false);
  });

  test("text is hit anywhere in its box", () => {
    const text = shape("t", "a0", { kind: "text", ...frame });
    assert.equal(hitShape(text, at(50, 30), 1), true);
    assert.equal(hitShape(text, at(150, 30), 1), false);
  });
});

describe("hitTop", () => {
  const scene = sceneOf(shape("back", "a0", { fill: "#000" }), shape("front", "a1", { fill: "#000", x: 5, y: 5 }));

  test("returns the front shape where two overlap, and skips the given id", () => {
    assert.equal(hitTop(scene, at(7, 7), 1), "front");
    assert.equal(hitTop(scene, at(7, 7), 1, sid("front")), "back");
    assert.equal(hitTop(scene, at(500, 500), 1), undefined);
  });
});

describe("inside", () => {
  test("needs full containment", () => {
    const scene = sceneOf(shape("in", "a0", { x: 10, y: 10 }), shape("half", "a1", { x: 95, y: 10 }));
    assert.deepEqual(inside(scene, { minX: 0, minY: 0, maxX: 100, maxY: 100 }), [sid("in")]);
  });
});

describe("handlesFor", () => {
  const view = (...selected: ReturnType<typeof shape>[]) => ({
    shapes: new Map(selected.map((s) => [s.id, s])),
    selection: new Set<ShapeId>(selected.map((s) => s.id)),
  });

  test("none for an empty selection, endpoints for one arrow, corners for text, eight handles otherwise", () => {
    assert.equal(handlesFor(view()).kind, "none");
    const arrow = shape("a", "a0", { kind: "arrow", x: 0, y: 0, w: -20, h: 10 });
    assert.deepEqual(handlesFor(view(arrow)), { kind: "arrow", id: "a", arrow: { x: 0, y: 0, w: -20, h: 10 } });
    const text = shape("t", "a1", { kind: "text" });
    assert.deepEqual(handlesFor(view(text)), { kind: "box", box: { x: 0, y: 0, w: 10, h: 10 }, corners: true, keepAspect: true });
    const mixed = handlesFor(view(text, shape("r", "a2", { x: 50 })));
    assert.deepEqual(mixed, { kind: "box", box: { x: 0, y: 0, w: 60, h: 10 }, corners: false, keepAspect: false });
  });

  test("handleAt finds a handle by its board point and none far away", () => {
    const handles: Handles = { kind: "box", box: { x: 0, y: 0, w: 100, h: 100 }, corners: false, keepAspect: false };
    assert.equal(handleAt(handles, at(101, 99), 1), "se");
    assert.equal(handleAt(handles, at(50, -1), 1), "n");
    assert.equal(handleAt(handles, at(50, 50), 1), undefined);
  });
});

describe("resizeTarget", () => {
  const from = { x: 0, y: 0, w: 100, h: 50 };

  test("each handle moves the edges it names", () => {
    assert.deepEqual(resizeTarget(from, "se", at(10, 20), NONE), { x: 0, y: 0, w: 110, h: 70 });
    assert.deepEqual(resizeTarget(from, "nw", at(10, 20), NONE), { x: 10, y: 20, w: 90, h: 30 });
    assert.deepEqual(resizeTarget(from, "e", at(10, 20), NONE), { x: 0, y: 0, w: 110, h: 50 });
    assert.deepEqual(resizeTarget(from, "n", at(10, 20), NONE), { x: 0, y: 20, w: 100, h: 30 });
    assert.deepEqual(resizeTarget(from, "ne", at(10, 20), NONE), { x: 0, y: 20, w: 110, h: 30 });
    assert.deepEqual(resizeTarget(from, "sw", at(10, 20), NONE), { x: 10, y: 0, w: 90, h: 70 });
  });

  test("dragging past the opposite edge flips the box", () => {
    assert.deepEqual(resizeTarget(from, "nw", at(150, 80), NONE), { x: 150, y: 80, w: -50, h: -30 });
  });

  test("keepAspect scales both sides by the larger ratio, about the opposite corner", () => {
    assert.deepEqual(resizeTarget(from, "se", at(100, 10), { keepAspect: true, fromCenter: false }), { x: 0, y: 0, w: 200, h: 100 });
    assert.deepEqual(resizeTarget(from, "nw", at(-100, 0), { keepAspect: true, fromCenter: false }), { x: -100, y: -50, w: 200, h: 100 });
  });

  test("fromCenter mirrors the move on the opposite edge", () => {
    assert.deepEqual(resizeTarget(from, "e", at(10, 0), { keepAspect: false, fromCenter: true }), { x: -10, y: 0, w: 120, h: 50 });
  });

  test("a zero-width box stays zero-width", () => {
    assert.deepEqual(resizeTarget({ x: 5, y: 0, w: 0, h: 40 }, "se", at(30, 10), NONE), { x: 5, y: 0, w: 0, h: 50 });
  });

  test("an arrow's handles move one end", () => {
    const arrow = { x: 10, y: 10, w: 40, h: 30 };
    assert.deepEqual(resizeTarget(arrow, "end", at(5, -5), NONE), { x: 10, y: 10, w: 45, h: 25 });
    assert.deepEqual(resizeTarget(arrow, "start", at(5, -5), NONE), { x: 15, y: 5, w: 35, h: 35 });
  });
});

describe("dragFrame", () => {
  test("a box tool runs from the down point to the pointer, and shift makes a square keeping the signs", () => {
    assert.deepEqual(dragFrame("rect", at(10, 10), at(60, 30), false), { x: 10, y: 10, w: 50, h: 20 });
    assert.deepEqual(dragFrame("rect", at(10, 10), at(60, 30), true), { x: 10, y: 10, w: 50, h: 50 });
    assert.deepEqual(dragFrame("rect", at(10, 10), at(-40, 30), true), { x: 10, y: 10, w: -50, h: 50 });
  });

  test("an arrow's angle snaps to 15 degrees with shift", () => {
    const frame = dragFrame("arrow", at(0, 0), at(100, 3), true);
    assert.ok(Math.abs(frame.h) < 1e-9, "close to horizontal snaps to horizontal");
    assert.ok(Math.abs(frame.w - Math.hypot(100, 3)) < 1e-9, "length kept");
  });
});

test("boxOf is the inverse of rectOf for a normalized box", () => {
  const box = { x: 3, y: 4, w: 5, h: 6 };
  assert.deepEqual(boxOf(rectOf(box)), box);
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseShape, penShape } from "../src/model/shapes.ts";
import { sid } from "./support/scenes.ts";

const record = (over: Record<string, unknown> = {}) => ({
  kind: "rect",
  x: 1,
  y: 2,
  w: 3,
  h: 4,
  z: "a0",
  stroke: "#000",
  fill: null,
  strokeWidth: 2,
  ...over,
});
const parse = (raw: unknown) => parseShape(sid("a"), raw);

describe("parseShape", () => {
  test("reads a record of each kind", () => {
    for (const kind of ["rect", "ellipse", "diamond", "arrow"]) {
      assert.deepEqual(parse(record({ kind })), { ...record({ kind }), id: "a" });
    }
    const text = record({ kind: "text", text: "héllo", fontSize: 18 });
    assert.deepEqual(parse(text), { ...text, id: "a" });
    const pen = record({ kind: "pen", points: [0, 0, 65535, 12] });
    assert.deepEqual(parse(pen), { ...pen, id: "a" });
  });

  test("takes a fill, a negative frame and a fractional width", () => {
    assert.ok(parse(record({ fill: "#fff", w: -3.5, h: -0.25, strokeWidth: 0.5 })));
  });

  test("ignores fields the kind does not have", () => {
    assert.deepEqual(parse(record({ text: "stray", points: [1] })), { ...record(), id: "a" });
  });

  test("rejects what the model could not have written", () => {
    const bad: [string, unknown][] = [
      ["not an object", 7],
      ["null", null],
      ["unknown kind", record({ kind: "blob" })],
      ["missing kind", record({ kind: undefined })],
      ["string coordinate", record({ x: "1" })],
      ["NaN", record({ w: Number.NaN })],
      ["infinite", record({ h: Number.POSITIVE_INFINITY })],
      ["missing stroke", record({ stroke: undefined })],
      ["number fill", record({ fill: 3 })],
      ["undefined fill", record({ fill: undefined })],
      ["width not a number", record({ strokeWidth: "2" })],
      ["empty z", record({ z: "" })],
      ["z that is not a fractional key", record({ z: "zz zz" })],
      ["z that is a number", record({ z: 5 })],
      ["text without a string", record({ kind: "text", fontSize: 12 })],
      ["text without a size", record({ kind: "text", text: "x" })],
      ["pen without points", record({ kind: "pen" })],
      ["pen with an odd point list", record({ kind: "pen", points: [1, 2, 3] })],
      ["pen with a fractional point", record({ kind: "pen", points: [1, 2.5] })],
      ["pen with a point out of range", record({ kind: "pen", points: [0, 65536] })],
      ["pen with a negative point", record({ kind: "pen", points: [-1, 0] })],
    ];
    for (const [name, raw] of bad) assert.equal(parse(raw), undefined, name);
  });
});

describe("penShape", () => {
  const style = { stroke: "#111", fill: null, strokeWidth: 2 };

  test("frames the points and stores them relative to the frame", () => {
    const pen = penShape([{ x: 100, y: 50 }, { x: 140, y: 90 }, { x: 120, y: 50 }], style);
    assert.equal(pen.kind, "pen");
    assert.deepEqual([pen.x, pen.y, pen.w, pen.h], [100, 50, 40, 40]);
    assert.deepEqual(pen.kind === "pen" && pen.points, [0, 0, 65535, 65535, 32768, 0]);
  });

  test("a straight or single-point stroke has a zero-size frame and points at 0", () => {
    const flat = penShape([{ x: 5, y: 10 }, { x: 5, y: 30 }], style);
    assert.deepEqual([flat.w, flat.h], [0, 20]);
    assert.deepEqual(flat.kind === "pen" && flat.points, [0, 0, 0, 65535]);
    const dot = penShape([{ x: 7, y: 8 }], style);
    assert.deepEqual([dot.x, dot.y, dot.w, dot.h], [7, 8, 0, 0]);
  });

  test("makes a shape that parses", () => {
    const pen = penShape(Array.from({ length: 200 }, (_, i) => ({ x: i * 1.37, y: Math.sin(i) * 90 })), style);
    assert.ok(parse({ ...pen, z: "a0" }));
  });
});

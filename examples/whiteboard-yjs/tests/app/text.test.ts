import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fontPxOf, naturalSize, newText, retextSize, scaleOf, type Measure, type TextShape } from "../../src/app/core/text.ts";
import { shape } from "../support/scenes.ts";

const measure: Measure = (line, px) => line.length * px * 0.6;
const textShape = (over: Record<string, unknown> = {}) => shape("t", "a0", { kind: "text", ...over }) as TextShape;

describe("naturalSize", () => {
  test("uses the widest line and gives height = lines x fontSize x 1.25", () => {
    assert.deepEqual(naturalSize("ab\nabcd", 10, measure), { w: 24, h: 25 });
  });

  test("an empty line still holds half an em", () => {
    assert.deepEqual(naturalSize("", 10, measure), { w: 5, h: 12.5 });
  });
});

describe("scale", () => {
  test("scaleOf an untouched text is 1, and fontPxOf is |h| / (lines x 1.25)", () => {
    const natural = naturalSize("a\nb", 16, measure);
    const shaped = textShape({ text: "a\nb", fontSize: 16, ...natural });
    assert.equal(scaleOf(shaped), 1);
    assert.equal(fontPxOf(shaped), 16);
    assert.equal(fontPxOf({ text: "a\nb", h: -50 }), 20);
  });

  test("retextSize keeps the scale after a resize and the signs of a flipped box", () => {
    const natural = naturalSize("ab", 10, measure);
    const doubled = textShape({ text: "ab", fontSize: 10, w: -natural.w * 2, h: -natural.h * 2 });
    assert.equal(scaleOf(doubled), 2);
    const size = retextSize(doubled, "abcd", measure);
    assert.deepEqual(size, { w: -naturalSize("abcd", 10, measure).w * 2, h: -natural.h * 2 });
  });
});

test("newText has a null fill and the natural size", () => {
  const made = newText({ x: 3, y: 4 }, "hey", 10, { stroke: "#123", fill: "#f00", strokeWidth: 2 }, measure);
  assert.deepEqual(made, { kind: "text", x: 3, y: 4, w: 18, h: 12.5, text: "hey", fontSize: 10, stroke: "#123", fill: null, strokeWidth: 2 });
});

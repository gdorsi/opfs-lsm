import assert from "node:assert/strict";
import { test } from "node:test";
import { digestShapes } from "../../src/model/digest.ts";
import { sampleShapes } from "../../src/app/core/sample.ts";
import { rig } from "./harness.ts";

const digestOf = async (count: number, seed: number) => {
  const r = await rig(sampleShapes(count, seed));
  return digestShapes(r.board.view().shapes);
};

test("the same seed gives the same board, another seed another", async () => {
  assert.equal(await digestOf(300, 7), await digestOf(300, 7));
  assert.notEqual(await digestOf(300, 7), await digestOf(300, 8));
});

test("the kind mix is within 2 points of 40/15/15/30 at 5,000", () => {
  const shapes = sampleShapes(5000, 5000);
  const share = (match: (kind: string) => boolean) => (shapes.filter((s) => match(s.kind)).length / shapes.length) * 100;
  assert.ok(Math.abs(share((k) => k === "rect" || k === "ellipse" || k === "diamond") - 40) < 2, "boxes");
  assert.ok(Math.abs(share((k) => k === "text") - 15) < 2, "text");
  assert.ok(Math.abs(share((k) => k === "arrow") - 15) < 2, "arrows");
  assert.ok(Math.abs(share((k) => k === "pen") - 30) < 2, "pen strokes");
});

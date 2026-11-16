import assert from "node:assert/strict";
import { test } from "node:test";
import { scatterShape } from "../src/model/index.ts";
import { seeded } from "./support/rng.ts";

test("the kind mix is within 2 points of 40/15/15/30 at 5,000", () => {
  const rng = seeded(5000);
  const shapes = Array.from({ length: 5000 }, () => scatterShape(rng));
  const share = (match: (kind: string) => boolean) => (shapes.filter((s) => match(s.kind)).length / shapes.length) * 100;
  assert.ok(Math.abs(share((k) => k === "rect" || k === "ellipse" || k === "diamond") - 40) < 2, "boxes");
  assert.ok(Math.abs(share((k) => k === "text") - 15) < 2, "text");
  assert.ok(Math.abs(share((k) => k === "arrow") - 15) < 2, "arrows");
  assert.ok(Math.abs(share((k) => k === "pen") - 30) < 2, "pen strokes");
});

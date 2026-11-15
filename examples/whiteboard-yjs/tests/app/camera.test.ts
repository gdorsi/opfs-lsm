import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  fitViewport,
  pinchViewport,
  snap,
  toBoard,
  toScreen,
  wheelPixels,
  wheelZoomFactor,
  zoomAt,
} from "../../src/app/core/camera.ts";

const view = { x: 120, y: -40, zoom: 0.5 };
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);

describe("transforms", () => {
  test("toBoard and toScreen round-trip", () => {
    const board = toBoard(view, { x: 300, y: 200 });
    const screen = toScreen(view, board);
    near(screen.x, 300);
    near(screen.y, 200);
  });

  test("zoomAt keeps the anchor's board point fixed and clamps to 0.02..8", () => {
    const anchor = { x: 300, y: 200 };
    const before = toBoard(view, anchor);
    const zoomed = zoomAt(view, anchor, 1.7);
    const after = toBoard(zoomed, anchor);
    near(after.x, before.x);
    near(after.y, before.y);
    assert.equal(zoomAt(view, anchor, 1e6).zoom, 8);
    assert.equal(zoomAt(view, anchor, 1e-6).zoom, 0.02);
  });

  test("pinchViewport keeps the midpoint's board point under the new midpoint", () => {
    const [a0, b0, a1, b1] = [{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 80, y: 120 }, { x: 280, y: 120 }];
    const next = pinchViewport(view, a0, b0, a1, b1);
    near(next.zoom, view.zoom * 2);
    const held = toBoard(view, { x: 150, y: 100 });
    const now = toBoard(next, { x: 180, y: 120 });
    near(now.x, held.x);
    near(now.y, held.y);
  });
});

describe("wheel", () => {
  test("wheelPixels handles deltaMode 0, 1 and 2", () => {
    assert.equal(wheelPixels(10, 0, 800), 10);
    assert.equal(wheelPixels(3, 1, 800), 48);
    assert.equal(wheelPixels(1, 2, 800), 800);
  });

  test("wheelZoomFactor clamps a +-100 notch", () => {
    near(wheelZoomFactor(-100), wheelZoomFactor(-50));
    assert.ok(wheelZoomFactor(-100) > 1 && wheelZoomFactor(100) < 1);
  });
});

describe("fitViewport", () => {
  const stage = { w: 1000, h: 600 };

  test("fits a large content rect and centers it", () => {
    const v = fitViewport({ minX: 0, minY: 0, maxX: 4000, maxY: 1000 }, stage);
    near(v.zoom, (1000 - 96) / 4000);
    const center = toBoard(v, { x: 500, y: 300 });
    near(center.x, 2000);
    near(center.y, 500);
  });

  test("never zooms in past maxZoom", () => {
    assert.equal(fitViewport({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, stage).zoom, 1);
    assert.equal(fitViewport({ minX: 0, minY: 0, maxX: 0, maxY: 0 }, stage, 2).zoom, 2);
  });
});

test("snap gives whole units at zoom <= 2 and eighths above", () => {
  assert.equal(snap(10.6, 1), 11);
  assert.equal(snap(10.6, 2), 11);
  assert.equal(snap(10.6, 4), 10.625);
});

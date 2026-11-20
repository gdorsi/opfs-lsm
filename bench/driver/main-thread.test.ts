import assert from "node:assert/strict";
import { test } from "node:test";
import { summarize } from "../page/main-thread.ts";

const steps = (n: number, ms: number, from = 0) => Array.from({ length: n }, (_, i) => from + i * ms);

test("the frame interval is the smallest step, so a run where most frames are late still counts the drops", () => {
  // Every frame ran 34 ms after the last: the vsync steps of the run are all 34, the display is 17.
  const stamps = steps(11, 34);
  const vsyncs = steps(10, 34);
  const alone = summarize([], stamps, vsyncs);
  assert.equal(alone.frameIntervalMs, 34);
  assert.equal(alone.droppedFrames, 0);
  const calibrated = summarize([], stamps, vsyncs, 17);
  assert.equal(calibrated.frameIntervalMs, 17);
  assert.equal(calibrated.droppedFrames, 10);
});

test("one frame in the run still has an interval from the calibration", () => {
  const stamps = [0, 70];
  assert.equal(summarize([], stamps, [50]).droppedFrames, 0);
  const s = summarize([], stamps, [50], 17);
  assert.equal(s.frameIntervalMs, 17);
  assert.equal(s.droppedFrames, 3);
});

test("a step in the run smaller than the calibration wins", () => {
  assert.equal(summarize([], [0, 10, 20], [0, 8, 17], 17).frameIntervalMs, 8);
});

test("with no calibration and no steps nothing is dropped", () => {
  const s = summarize([], [0, 500], [10]);
  assert.equal(s.frameIntervalMs, 0);
  assert.equal(s.droppedFrames, 0);
});

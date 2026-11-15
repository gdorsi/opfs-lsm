import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { recount, type Pause } from "./recount.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** A count of three steps with a pause between each, recording the steps it ran. */
function stepped() {
  const steps: number[] = [];
  const count = async (pause?: Pause) => {
    for (let step = 1; step <= 3; step++) {
      if (step > 1) await pause?.();
      steps.push(step);
    }
    return steps.length;
  };
  return { steps, count };
}

describe("recount", () => {
  it("pauses between the steps of the first count unless the page is hidden, and stops it once no one is subscribed", async () => {
    const visible = stepped();
    recount(() => () => {}, visible.count, () => {}, () => false)();
    await settle();
    assert.deepEqual(visible.steps, [1]);
    const hidden = stepped();
    recount(() => () => {}, hidden.count, () => {}, () => true)();
    await settle();
    assert.deepEqual(hidden.steps, [1, 2, 3]);
  });

  it("paces recounts four times a count's duration apart while changes keep coming, and recounts once they stop", async () => {
    for (const keepChanging of [false, true]) {
      let changed = () => {};
      const started: number[] = [];
      let ended = 0;
      const count = async () => {
        started.push(performance.now());
        if (started.length === 1) {
          changed();
          // A count that waits 300 ms, as one does on OPFS reads while the SharedWorker writes and compacts.
          await new Promise((resolve) => setTimeout(resolve, 300));
          ended = performance.now();
        }
        return started.length;
      };
      const off = recount((onChange) => ((changed = onChange), () => {}), count, () => {}, () => false);
      for (const until = performance.now() + 3000; started.length < 2 && performance.now() < until; ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (keepChanging) changed();
      }
      off();
      assert.ok(started.length >= 2, `${keepChanging ? "paced" : "quiet"}: no recount within 3 s`);
      const waited = started[1]! - ended;
      if (keepChanging) assert.ok(waited >= 1100, `paced: waited ${waited.toFixed(0)} ms`);
      else assert.ok(waited >= 200 && waited < 600, `quiet: waited ${waited.toFixed(0)} ms`);
    }
  });

  it("stops a recount at its next pause once no one is subscribed", async () => {
    let changed = () => {};
    const { steps, count } = stepped();
    const off = recount((onChange) => ((changed = onChange), () => {}), count, () => {}, () => false);
    await settle();
    steps.length = 0;
    changed();
    off();
    await settle();
    assert.deepEqual(steps, [1]);
  });
});

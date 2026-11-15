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

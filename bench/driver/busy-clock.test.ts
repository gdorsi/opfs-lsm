import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BusyClock } from "../page/busy-clock.ts";

function clock() {
  let t = 0;
  const busy = new BusyClock(() => t);
  return { busy, at: (x: number) => void (t = x) };
}

describe("BusyClock", () => {
  test("counts only the time a call is in flight", () => {
    const { busy, at } = clock();
    at(10);
    busy.enter();
    at(14);
    busy.exit();
    at(100);
    busy.enter();
    at(101);
    busy.exit();
    assert.equal(busy.ms, 5);
  });

  test("a nested call is not counted twice", () => {
    const { busy, at } = clock();
    at(0);
    busy.enter();
    at(2);
    busy.enter();
    at(5);
    busy.exit();
    at(9);
    busy.exit();
    assert.equal(busy.ms, 9);
  });

  test("overlapping calls count their union", () => {
    const { busy, at } = clock();
    at(0);
    busy.enter();
    at(4);
    busy.enter();
    at(6);
    busy.exit();
    at(10);
    busy.exit();
    assert.equal(busy.ms, 10);
  });
});

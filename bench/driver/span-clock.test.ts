import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SpanClock } from "../page/span-clock.ts";

function clock() {
  let t = 0;
  const span = new SpanClock(() => t);
  return { span, at: (x: number) => void (t = x) };
}

describe("SpanClock", () => {
  test("counts from the first call's start to the last call's end, gaps included", () => {
    const { span, at } = clock();
    at(10);
    span.enter();
    at(14);
    span.exit();
    at(100);
    span.enter();
    at(101);
    span.exit();
    assert.equal(span.ms, 91);
  });

  test("no call is no span", () => {
    assert.equal(clock().span.ms, 0);
  });

  test("a nested call is inside the span of the call around it", () => {
    const { span, at } = clock();
    at(0);
    span.enter();
    at(2);
    span.enter();
    at(5);
    span.exit();
    at(9);
    span.exit();
    assert.equal(span.ms, 9);
  });

  test("overlapping calls span from the earliest start to the latest end", () => {
    const { span, at } = clock();
    at(0);
    span.enter();
    at(4);
    span.enter();
    at(6);
    span.exit();
    at(10);
    span.exit();
    assert.equal(span.ms, 10);
  });
});

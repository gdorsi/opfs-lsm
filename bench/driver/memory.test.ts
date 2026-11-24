import assert from "node:assert/strict";
import { test } from "node:test";
import { PeakTracker } from "./memory.ts";

test("the total is the largest sample, not the sum of peaks from different samples", () => {
  const peaks = new PeakTracker();
  peaks.add({ usedSize: 100, totalSize: 120, backingStorageSize: 5 }, 10);
  peaks.add({ usedSize: 20, totalSize: 120, backingStorageSize: 50 }, 80);
  const { heap, wasmBytes, totalBytes } = peaks.peak();
  assert.equal(heap?.usedSize, 100);
  assert.equal(heap?.backingStorageSize, 50);
  assert.equal(wasmBytes, 80);
  assert.equal(totalBytes, 150);
});

test("no sample gives no total", () => {
  assert.deepEqual(new PeakTracker().peak(), { heap: null, wasmBytes: null, totalBytes: null });
});

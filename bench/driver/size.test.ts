import assert from "node:assert/strict";
import { test } from "node:test";
import { overBudget, type Bytes3, type SizeResult } from "./size.ts";

const bytes = (gzip: number, brotli: number): Bytes3 => ({ raw: 0, gzip, brotli });
const row = (over: Partial<SizeResult>): SizeResult => ({ id: "kv", note: "", atImport: bytes(100, 90), afterOpen: bytes(300, 270), files: [], ...over });

test("a row with no budget passes", () => {
  assert.deepEqual(overBudget([row({})]), []);
});

test("a row at its budgets passes", () => {
  assert.deepEqual(overBudget([row({ budget: 270, importBudget: 100 })]), []);
});

test("the after-open budget counts brotli bytes", () => {
  assert.deepEqual(overBudget([row({ budget: 269 })]), ["kv after open 270 > 269 brotli"]);
});

test("the at-import budget counts gzip bytes, whatever is loaded later", () => {
  assert.deepEqual(overBudget([row({ budget: 270, importBudget: 99 })]), ["kv at import 100 > 99 gzip"]);
});

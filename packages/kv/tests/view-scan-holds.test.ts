import { afterEach, expect, it } from "vitest";
import type { Db, ViewSnapshot } from "../src/index.js";
import { readPastViewCallback } from "./view-read.js";

/**
 * A scan of a view that still waits for a page when the view's callback
 * returns reads the view's runs to the end: the compaction that replaces
 * them meanwhile does not take their files away. `file-holds.test.ts` asks
 * the same of the handle's own get, getMany and count.
 */
const dec = new TextDecoder();
const utf = (s: string) => new TextEncoder().encode(s);
const opened: Db[] = [];

afterEach(async () => {
  for (const db of opened.splice(0)) await db.close();
});

const scans: [string, (snap: ViewSnapshot) => Promise<unknown>, unknown][] = [
  ["count", (snap) => snap.count(), 3],
  ["rangeValues", async (snap) => (await snap.rangeValues({}, (v) => dec.decode(v))).map((e) => e.value), ["v0", "v1", "v2"]],
  ["rangeJoin", async (snap) => (await snap.rangeJoin({}, () => utf("k1"))).map((j) => dec.decode(j.joined!)), ["v1", "v1", "v1"]],
];

it.each(scans)("a cold %s of a view that waits past the view's callback keeps the runs it reads", async (_what, read, want) => {
  expect(await readPastViewCallback(read, opened)).toEqual({ outcome: { value: want }, kept: true });
});

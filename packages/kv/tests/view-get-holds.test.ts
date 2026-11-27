import { afterEach, expect, it } from "vitest";
import type { Db, ViewSnapshot } from "../src/index.js";
import { readPastViewCallback } from "./view-read.js";

/**
 * As `view-scan-holds.test.ts`, for the point reads of a view: a get that
 * still waits for a page when the view's callback returns reads the view's
 * runs to the end, as the view's scans and the handle's own get do.
 */
const dec = new TextDecoder();
const utf = (s: string) => new TextEncoder().encode(s);
const opened: Db[] = [];

afterEach(async () => {
  for (const db of opened.splice(0)) await db.close();
});

const gets: [string, (snap: ViewSnapshot) => Promise<unknown>, unknown][] = [
  ["get", async (snap) => dec.decode((await snap.get(utf("k1")))!), "v1"],
  ["getMany", async (snap) => (await snap.getMany([utf("k0"), utf("k2")])).map((v) => dec.decode(v!)), ["v0", "v2"]],
];

it.each(gets)("a cold %s of a view that waits past the view's callback keeps the runs it reads", async (_what, read, want) => {
  expect(await readPastViewCallback(read, opened)).toEqual({ outcome: { value: want }, kept: true });
});

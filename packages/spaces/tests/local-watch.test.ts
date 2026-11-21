import { expect, test } from "vitest";
import { toBase64url } from "../src/bytes.js";
import { coll, newId, openTab, put, randomSpace, uniqueName } from "./local-util.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 20));

test("watch fires once for another tab's writes, coalesced, and only for its own collection", async () => {
  const name = uniqueName();
  const a = await openTab(name);
  const b = await openTab(name);
  const space = randomSpace();
  let fired = 0;
  const stop = a.store.watch(coll(a, "lists"), () => fired++);
  await put(b, "todos", newId(space), { list: toBase64url(newId(space)), title: "t", position: "p" }, true);
  await b.kv.sync();
  await tick();
  expect(fired).toBe(0);
  await Promise.all([put(b, "lists", newId(space), { title: "x" }, true), put(b, "lists", newId(space), { title: "y" }, true)]);
  await tick();
  expect(fired).toBeGreaterThanOrEqual(1);
  expect(fired).toBeLessThanOrEqual(2);
  const before = fired;
  await put(a, "lists", newId(space), { title: "own tab" }, true);
  await tick();
  expect(fired).toBeGreaterThan(before);
  stop();
  const final = fired;
  await put(b, "lists", newId(space), { title: "after stop" }, true);
  await tick();
  expect(fired).toBe(final);
});

test("many writes in one tick fire the listener once", async () => {
  const tab = await openTab(uniqueName());
  const space = randomSpace();
  let fired = 0;
  tab.store.watch(coll(tab, "lists"), () => fired++);
  await tab.store.write(
    Array.from({ length: 5 }, () => ({
      kind: "put" as const,
      coll: coll(tab, "lists"),
      id: newId(space),
      create: true,
      patch: new Map([["title", "t"]]),
      files: [],
    })),
  );
  await tick();
  expect(fired).toBe(1);
});

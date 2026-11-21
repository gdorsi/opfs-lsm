import { expect, test } from "vitest";
import { toBase64url } from "../src/bytes.js";
import { SpacesError } from "../src/errors.js";
import { recordBytes } from "../src/ids.js";
import type { RecordKeyId, SpaceId } from "../src/ids.js";
import { encodeCursor } from "../src/local/store.js";
import type { QueryInput, ResolvePlan } from "../src/local/store.js";
import { coll, newId, openTab, put, randomSpace, tagOfSpace, uniqueName } from "./local-util.js";
import type { Tab } from "./local-util.js";

const text = (id: Uint8Array) => toBase64url(id);

async function seed() {
  const tab = await openTab(uniqueName());
  const space = randomSpace();
  const listA = newId(space);
  const listB = newId(space);
  await put(tab, "lists", listA, { title: "A" }, true);
  await put(tab, "lists", listB, { title: "B" }, true);
  const rows: Record<string, RecordKeyId> = {};
  const titles: [string, string, string, boolean][] = [
    ["a1", "alpha", "d", false],
    ["a2", "beta", "a", true],
    ["a3", "alphabet", "c", false],
    ["a4", "gamma", "b", true],
    ["b1", "delta", "a", false],
  ];
  for (const [key, title, position, done] of titles) {
    const id = newId(space);
    rows[key] = id;
    await put(tab, "todos", id, { list: text(key[0] === "a" ? listA : listB), title, position, done }, true);
  }
  return { tab, space, listA, listB, rows };
}

async function run(tab: Tab, name: string, q: QueryInput, extra: Partial<{ filter: (r: { id: string }) => boolean; resolve: ResolvePlan }> = {}) {
  const c = coll(tab, name);
  const plan = { ...tab.store.plan(c, q), ...extra };
  return tab.store.query(plan);
}

const titlesOf = (rows: readonly { id: string }[]) => rows.map((r) => (r as unknown as { title: string }).title);

test("index queries: eq, bounds, startsWith, reverse", async () => {
  const { tab, listA } = await seed();
  const eq = [text(listA)];
  expect(titlesOf((await run(tab, "todos", { index: "byList", eq })).rows)).toEqual(["beta", "gamma", "alphabet", "alpha"]);
  expect(titlesOf((await run(tab, "todos", { index: "byList", eq, reverse: true })).rows)).toEqual(["alpha", "alphabet", "gamma", "beta"]);
  expect(titlesOf((await run(tab, "todos", { index: "byList", eq, gte: "b" })).rows)).toEqual(["gamma", "alphabet", "alpha"]);
  expect(titlesOf((await run(tab, "todos", { index: "byList", eq, gt: "b" })).rows)).toEqual(["alphabet", "alpha"]);
  expect(titlesOf((await run(tab, "todos", { index: "byList", eq, lt: "c" })).rows)).toEqual(["beta", "gamma"]);
  expect(titlesOf((await run(tab, "todos", { index: "byList", eq, lte: "c" })).rows)).toEqual(["beta", "gamma", "alphabet"]);
  expect(titlesOf((await run(tab, "todos", { index: "byList", eq, gt: "a", lt: "d" })).rows)).toEqual(["gamma", "alphabet"]);
  const unknown = await run(tab, "todos", { index: "nope" }).catch((e: unknown) => e);
  expect((unknown as SpacesError).code).toBe("validation");
});

test("startsWith, a number-free boolean index and bounds on a leading field", async () => {
  const { tab } = await seed();
  expect(titlesOf((await run(tab, "todos", { index: "byDone", eq: [true] })).rows)).toEqual(["beta", "gamma"]);
  expect(titlesOf((await run(tab, "todos", { index: "byDone", eq: [false], startsWith: "al" })).rows)).toEqual(["alpha", "alphabet"]);
  expect(titlesOf((await run(tab, "todos", { index: "byDone", gte: true })).rows)).toEqual(["beta", "gamma"]);
  expect(titlesOf((await run(tab, "todos", { index: "byDone", lt: true })).rows)).toEqual(["alpha", "alphabet", "delta"]);
  expect((await run(tab, "todos", { index: "byDone", eq: [false], startsWith: "zz" })).rows).toEqual([]);
});

test("limit with after pages through an index and reports the next key only when more follow", async () => {
  const { tab, listA } = await seed();
  const eq = [text(listA)];
  const seen: string[] = [];
  let after: string | undefined;
  const sizes: number[] = [];
  for (;;) {
    const page = await run(tab, "todos", { index: "byList", eq, limit: 3, ...(after === undefined ? {} : { after }) });
    sizes.push(page.rows.length);
    seen.push(...titlesOf(page.rows));
    if (page.nextKey === undefined) break;
    after = encodeCursor(page.nextKey);
  }
  expect(seen).toEqual(["beta", "gamma", "alphabet", "alpha"]);
  expect(sizes).toEqual([3, 1]);
  // exactly full: no phantom next page
  const full = await run(tab, "todos", { index: "byList", eq, limit: 4 });
  expect(full.rows).toHaveLength(4);
  expect(full.nextKey).toBeUndefined();
  // reverse paging
  const rev = await run(tab, "todos", { index: "byList", eq, limit: 3, reverse: true });
  const rest = await run(tab, "todos", { index: "byList", eq, reverse: true, after: encodeCursor(rev.nextKey!) });
  expect([...titlesOf(rev.rows), ...titlesOf(rest.rows)]).toEqual(["alpha", "alphabet", "gamma", "beta"]);
  expect((await run(tab, "todos", { index: "byList", eq, limit: 0 })).rows).toEqual([]);
});

test("a cursor from another query is refused", async () => {
  const { tab, listA, listB } = await seed();
  const page = await run(tab, "todos", { index: "byList", eq: [text(listA)], limit: 1 });
  const err = await run(tab, "todos", { index: "byList", eq: [text(listB)], after: encodeCursor(page.nextKey!) }).catch((e: unknown) => e);
  expect((err as SpacesError).code).toBe("validation");
  const bad = await run(tab, "todos", { index: "byList", eq: [text(listA)], after: "!!" }).catch((e: unknown) => e);
  expect((bad as SpacesError).code).toBe("validation");
});

test("filter runs after the range and limit counts rows that pass", async () => {
  const { tab, listA } = await seed();
  const filter = (r: { id: string }) => (r as unknown as { done: boolean }).done === false;
  const page = await run(tab, "todos", { index: "byList", eq: [text(listA)], limit: 1 }, { filter });
  expect(titlesOf(page.rows)).toEqual(["alphabet"]);
  expect(page.nextKey).toBeDefined();
  const next = await run(tab, "todos", { index: "byList", eq: [text(listA)], limit: 1, after: encodeCursor(page.nextKey!) }, { filter });
  expect(titlesOf(next.rows)).toEqual(["alpha"]);
  expect(next.nextKey).toBeUndefined();
});

test("scans: all records of a collection, or of one space", async () => {
  const { tab, space } = await seed();
  const other = randomSpace();
  await put(tab, "lists", newId(other), { title: "elsewhere" }, true);
  expect((await run(tab, "lists", {})).rows).toHaveLength(3);
  expect(titlesOf((await run(tab, "lists", { space: tagOfSpace(space) })).rows).sort()).toEqual(["A", "B"]);
  expect(titlesOf((await run(tab, "lists", { space: tagOfSpace(other) })).rows)).toEqual(["elsewhere"]);
  const err = await run(tab, "lists", { gt: "x" }).catch((e: unknown) => e);
  expect((err as SpacesError).code).toBe("validation");
});

test("resolve loads one and two levels from the same snapshot, and leaves a missing target undefined", async () => {
  const { tab, space, listA, rows } = await seed();
  const item = newId(space);
  await put(tab, "items", item, { todo: text(rows["a2"]!), label: "sub" }, true);
  const todos = coll(tab, "todos");
  const lists = coll(tab, "lists");
  const items = coll(tab, "items");
  const one: ResolvePlan = new Map([["todo", { target: todos, nested: undefined }]]);
  const two: ResolvePlan = new Map([["todo", { target: todos, nested: new Map([["list", { target: lists, nested: undefined }]]) }]]);
  const r1 = (await run(tab, "items", {}, { resolve: one })).rows[0] as unknown as { todo: { title: string; list: string } };
  expect(r1.todo.title).toBe("beta");
  expect(r1.todo.list).toBe(text(listA));
  const r2 = (await run(tab, "items", {}, { resolve: two })).rows[0] as unknown as { todo: { list: { title: string } } };
  expect(r2.todo.list.title).toBe("A");
  const got = (await tab.store.get(items, item, two)) as unknown as { todo: { list: { title: string } } };
  expect(got.todo.list.title).toBe("A");
  await tab.store.write([{ kind: "delete", coll: todos, id: rows["a2"]! }]);
  const r3 = (await run(tab, "items", {}, { resolve: one })).rows[0] as unknown as { todo: unknown };
  expect(r3.todo).toBeUndefined();
});

test("a record with a missing required field is hidden from reads and indexes, and appears when it is filled", async () => {
  const tab = await openTab(uniqueName());
  const space: SpaceId = randomSpace();
  const list = newId(space);
  const id = newId(space);
  // no `position`, which is required
  await put(tab, "todos", id, { list: text(list), title: "half" }, true);
  const todos = coll(tab, "todos");
  expect(await tab.store.get(todos, id)).toBeUndefined();
  expect(await tab.store.status(todos, id)).toBe("unreadable");
  expect((await run(tab, "todos", { index: "byList", eq: [text(list)] })).rows).toEqual([]);
  expect((await run(tab, "todos", {})).rows).toEqual([]);
  expect(await tab.kv.count(indexRange(tab))).toBe(0);
  await put(tab, "todos", id, { position: "a" });
  expect(await tab.store.status(todos, id)).toBe("live");
  expect(titlesOf((await run(tab, "todos", { index: "byList", eq: [text(list)] })).rows)).toEqual(["half"]);
  expect(await tab.kv.count(indexRange(tab))).toBe(2);
});

function indexRange(tab: Tab) {
  const c = coll(tab, "todos");
  const start = new Uint8Array([0x73, 0x03, c.id]);
  return { start, endExclusive: new Uint8Array([0x73, 0x03, c.id + 1]) };
}

test("a field with a default reads and indexes as its default", async () => {
  const tab = await openTab(uniqueName());
  const space = randomSpace();
  const id = newId(space);
  await put(tab, "todos", id, { list: text(newId(space)), title: "t", position: "p" }, true);
  const row = (await tab.store.get(coll(tab, "todos"), id)) as unknown as { done: boolean };
  expect(row.done).toBe(false);
  expect(titlesOf((await run(tab, "todos", { index: "byDone", eq: [false] })).rows)).toEqual(["t"]);
  expect(recordBytes(text(id) as never)).toEqual(id);
});

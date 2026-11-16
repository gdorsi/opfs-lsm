import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, test } from "node:test";
import { newPageId } from "../src/model/bodies.ts";
import { PERSISTENCE_KEY } from "../src/model/tree.ts";
import type { PageId } from "../src/model/types.ts";
import { openServerDb } from "../src/server/db.ts";
import { createServer } from "../src/server/fate.ts";
import { seedDb } from "../src/server/seed.ts";

let db: DatabaseSync;
let server: ReturnType<typeof createServer>;
beforeEach(() => {
  db = openServerDb(":memory:");
  server = createServer(db);
});

type Result = { ok: boolean; data?: any; error?: { code: string } };

async function call(operation: Record<string, unknown>): Promise<Result> {
  const response = await server.handleRequest(
    new Request("http://pages/api/fate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operations: [{ id: "1", select: [], ...operation }], version: operation.mutation ? 3 : 1 }),
    }),
  );
  return ((await response.json()) as { results: Result[] }).results[0]!;
}

const identity = () => {
  const now = Date.now();
  return { id: `fate:1:${now}:${now + 86_400_000}:${randomUUID()}`, scope: PERSISTENCE_KEY };
};
const mutate = (name: string, input: unknown, mutation = identity()) => call({ kind: "mutation", name, input, select: ["id", "parentId", "title"], mutation });
const create = async (parentId: PageId | null, title = "") => {
  const id = newPageId();
  const result = await mutate("createPage", { id, parentId, title });
  assert.ok(result.ok, `create ${title}: ${JSON.stringify(result.error)}`);
  return id;
};
const children = async (parent: PageId | null, first = 200, after?: string) => {
  const result = await call({ kind: "list", name: "children", args: { parent, first, ...(after && { after }) }, select: ["id", "title"] });
  assert.ok(result.ok, JSON.stringify(result.error));
  return result.data as { items: { cursor: string; node: { id: PageId; title: string } }[]; pagination: { hasNext: boolean; nextCursor?: string } };
};
const ids = async (parent: PageId | null) => (await children(parent)).items.map((item) => item.node.id);
const count = () => (db.prepare("SELECT COUNT(*) AS n FROM page").get() as { n: number }).n;

test("children list in creation order, and a delete takes the whole subtree", async () => {
  const a = await create(null, "A");
  const b = await create(null, "B");
  const a1 = await create(a, "A1");
  const a2 = await create(a, "A2");
  const a11 = await create(a1, "A11");
  assert.deepEqual(await ids(null), [a, b]);
  assert.deepEqual(await ids(a), [a1, a2]);
  assert.ok((await mutate("deletePage", { id: a })).ok);
  assert.deepEqual(await ids(null), [b], "A left the top level");
  assert.deepEqual([await ids(a), await ids(a1)], [[], []], "the cascade removed A's children and grandchild");
  assert.equal(count(), 1, `only B is left (A11 was ${a11})`);
});

test("250 children page as 200, then 50", async () => {
  const parent = await create(null, "P");
  const made: PageId[] = [];
  for (let i = 0; i < 250; i++) made.push(await create(parent, `c${i}`));
  const first = await children(parent);
  assert.equal(first.items.length, 200);
  assert.equal(first.pagination.hasNext, true);
  const rest = await children(parent, 200, first.pagination.nextCursor);
  assert.equal(rest.items.length, 50);
  assert.equal(rest.pagination.hasNext, false);
  assert.deepEqual([...first.items, ...rest.items].map((item) => item.node.id), made);
});

test("an unknown parent has no children", async () => {
  assert.deepEqual(await ids(newPageId()), []);
});

test("bad input is refused with a 400, a missing parent or page is NOT_FOUND, a missing delete succeeds", async () => {
  const page = await create(null, "P");
  // fate validates mutation inputs itself (VALIDATION_ERROR) and list args through `parse` (BAD_REQUEST); both are 400, which the client does not retry.
  assert.equal((await mutate("renamePage", { id: page, title: "x".repeat(501) })).error?.code, "VALIDATION_ERROR", "title over 500");
  assert.ok((await mutate("renamePage", { id: page, title: "x".repeat(500) })).ok, "title of 500");
  assert.equal((await mutate("createPage", { id: "not-an-id", parentId: null, title: "" })).error?.code, "VALIDATION_ERROR", "bad id");
  assert.equal((await call({ kind: "list", name: "children", args: { parent: "nope", first: 10 } })).error?.code, "BAD_REQUEST", "bad parent");
  assert.equal((await call({ kind: "list", name: "children", args: { parent: null, first: 201 } })).error?.code, "BAD_REQUEST", "first over 200");
  assert.equal((await mutate("createPage", { id: newPageId(), parentId: newPageId(), title: "" })).error?.code, "NOT_FOUND", "missing parent");
  assert.equal((await mutate("renamePage", { id: newPageId(), title: "t" })).error?.code, "NOT_FOUND", "missing page");
  assert.ok((await mutate("deletePage", { id: newPageId() })).ok, "deleting a missing page succeeds");
});

test("one mutation id sent twice applies once", async () => {
  const mutation = identity();
  const input = { id: newPageId(), parentId: null, title: "Once" };
  const first = await mutate("createPage", input, mutation);
  const replay = await mutate("createPage", input, mutation);
  assert.ok(first.ok && replay.ok, JSON.stringify([first.error, replay.error]));
  assert.deepEqual(replay.data, first.data);
  assert.equal(count(), 1);
});

test("a byId read returns the page header", async () => {
  const parent = await create(null, "Parent");
  const page = await create(parent, "Child");
  const result = await call({ kind: "byId", type: "Page", ids: [page], select: ["id", "parentId", "title"] });
  assert.ok(result.ok, JSON.stringify(result.error));
  assert.deepEqual(result.data, [{ id: page, parentId: parent, title: "Child" }]);
});

test("a level reads from the children index, with no sort step", () => {
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT seq, id FROM page WHERE parent_id IS ? AND seq > ? ORDER BY seq LIMIT ?").all(null, 0, 10);
  assert.deepEqual(plan.map((row) => row.detail), ["SEARCH page USING INDEX page_children (parent_id=? AND seq>?)"]);
});

test("a reseed keeps every page id", async () => {
  assert.equal(seedDb(db).pages, 14);
  const before = db.prepare("SELECT id, parent_id, title FROM page ORDER BY seq").all();
  seedDb(db);
  assert.deepEqual(db.prepare("SELECT id, parent_id, title FROM page ORDER BY seq").all(), before);
  assert.deepEqual((await children(null)).items.map((item) => item.node.title), ["Getting started", "Projects", "Journal", "Reading list"]);
});

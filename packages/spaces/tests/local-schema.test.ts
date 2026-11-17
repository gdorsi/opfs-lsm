import { openHarnessDb } from "@opfs-lsm/kv/testing";
import { z } from "zod";
import { expect, test } from "vitest";
import { toBase64url } from "../src/bytes.js";
import { SpacesError } from "../src/errors.js";
import { Clock } from "../src/local/record.js";
import { LocalStore } from "../src/local/store.js";
import { collection, defineSchema, file, ref, richText } from "../src/schema.js";
import {
  List,
  Todo,
  Item,
  coll,
  cursor,
  newId,
  openTab,
  put,
  randomSpace,
  recordItem,
  serverPage,
  remoteState,
  schemaV1,
  schemaV2,
  spaceBytesOf,
  uniqueName,
} from "./local-util.js";

const code = async (p: Promise<unknown>) => ((await p.then(() => undefined, (e: unknown) => e)) as SpacesError | undefined)?.code;

async function seeded(name: string) {
  const tab = await openTab(name);
  const space = randomSpace();
  const ids = [];
  for (const title of ["one", "two", "three"]) {
    const id = newId(space);
    ids.push(id);
    await put(tab, "todos", id, { list: toBase64url(newId(space)), title, position: title[0]! }, true);
  }
  await tab.store.applyRemote(serverPage(space, [], 5));
  return { tab, space, ids };
}

test("a version bump adds an index, fills it, keeps the others and the cursors, and leaves an older tab stale", async () => {
  const name = uniqueName();
  const { tab: v1, space, ids } = await seeded(name);
  expect(await v1.store.readCursor(spaceBytesOf(space))).toEqual(cursor(5));

  const v2 = await openTab(name, schemaV2);
  expect(v2.store.catalog.version).toBe(2);
  const todos = coll(v2, "todos");
  expect(todos.indexes.map((i) => [i.name, i.state])).toEqual([["byList", "ready"], ["byDone", "ready"], ["byTitle", "ready"]]);
  const page = await v2.store.query(v2.store.plan(todos, { index: "byTitle" }));
  expect((page.rows as unknown as { title: string }[]).map((r) => r.title)).toEqual(["one", "three", "two"]);
  // existing indexes were rebuilt with their entries intact
  const byList = await v2.store.query(v2.store.plan(todos, { index: "byDone", eq: [false] }));
  expect(byList.rows).toHaveLength(3);
  expect(await v2.store.readCursor(spaceBytesOf(space))).toEqual(cursor(5));

  // the old tab refuses to write
  expect(await code(put(v1, "todos", ids[0]!, { title: "late" }))).toBe("stale-schema");
  expect(await code(v1.store.applyRemote(serverPage(space, [], 6)))).toBe("stale-schema");
  // and cannot open again
  expect(await code(openTab(name, schemaV1))).toBe("stale-schema");
  // while the new tab writes and maintains the new index
  await put(v2, "todos", ids[0]!, { title: "uno" });
  const again = await v2.store.query(v2.store.plan(todos, { index: "byTitle", eq: ["uno"] }));
  expect(again.rows).toHaveLength(1);
});

test("a second tab opening the same version attaches to the stored catalog", async () => {
  const name = uniqueName();
  const a = await openTab(name, schemaV2);
  const b = await openTab(name, schemaV2);
  expect(b.store.catalog.bytes).toEqual(a.store.catalog.bytes);
  const space = randomSpace();
  const id = newId(space);
  await put(a, "todos", id, { list: toBase64url(newId(space)), title: "x", position: "p" }, true);
  await put(b, "todos", id, { title: "y" });
});

test("a changed declaration under the same version is refused", async () => {
  const name = uniqueName();
  await openTab(name, schemaV2);
  const other = collection("todos", Todo.shape, { indexes: { byList: ["list", "position"] } });
  expect(await code(openTab(name, defineSchema({ version: 2, collections: [List, other, Item] })))).toBe("schema");
});

test("an upgrade re-validates cells, fills defaults and hides records whose required field became invalid", async () => {
  const name = uniqueName();
  const { tab: v1, space } = await seeded(name);
  const keep = newId(space);
  await put(v1, "todos", keep, { list: toBase64url(newId(space)), title: "keeper", position: "k" }, true);
  const shape3 = {
    ...Todo.shape,
    title: z.string().min(4), // "one" and "two" become invalid, "three" and "keeper" stay
    prio: z.number().default(7),
  };
  const Todo3 = collection("todos", shape3, { indexes: { byList: ["list", "position"], byPrio: ["prio"] } });
  const v3 = await openTab(name, defineSchema({ version: 3, collections: [List, Todo3, Item] }));
  const todos = coll(v3, "todos");
  const rows = (await v3.store.query(v3.store.plan(todos, {}))).rows as unknown as { title: string; prio: number }[];
  expect(rows.map((r) => r.title).sort()).toEqual(["keeper", "three"]);
  expect(rows.every((r) => r.prio === 7)).toBe(true);
  const byPrio = await v3.store.query(v3.store.plan(todos, { index: "byPrio", eq: [7] }));
  expect(byPrio.rows).toHaveLength(2);
  expect(await v3.store.status(todos, keep)).toBe("live");
  // the invalid cells are kept: widening the validator again brings the records back
  const v4 = await openTab(name, defineSchema({ version: 4, collections: [List, collection("todos", Todo.shape, { indexes: { byList: ["list", "position"] } }), Item] }));
  expect((await v4.store.query(v4.store.plan(coll(v4, "todos"), {}))).rows).toHaveLength(4);
});

test("an upgrade pulls records the old version skipped, because the cursors are gone", async () => {
  const name = uniqueName();
  const { tab } = await seeded(name);
  const Extra = collection("extras", { label: z.string() });
  const v2 = await openTab(name, defineSchema({ version: 2, collections: [List, Todo, Item, Extra] }));
  const space = randomSpace();
  const id = newId(space);
  await v2.store.applyRemote(serverPage(space, [recordItem(id, 1, remoteState("extras", { label: "now declared" }, new Clock(2)))], 1));
  expect(await v2.store.get(coll(v2, "extras"), id)).toMatchObject({ label: "now declared" });
  expect(tab).toBeDefined();
});

test("open refuses a store whose catalog is newer than this tab's schema", async () => {
  const name = uniqueName();
  await openTab(name, schemaV2);
  const kv = (await openTab(name, schemaV2)).kv;
  expect(await code(LocalStore.open(kv, schemaV1, new Clock(1)))).toBe("stale-schema");
});

test("defineSchema refuses unknown ref targets, duplicate and reserved names and bad indexes at runtime", () => {
  const bad = (schema: unknown) => {
    try {
      defineSchema(schema as never);
    } catch (e) {
      return (e as SpacesError).code;
    }
    return "ok";
  };
  const orphan = collection("orphans", { owner: ref("users") });
  expect(bad({ version: 1, collections: [orphan] })).toBe("schema");
  expect(bad({ version: 1, collections: [List, List] })).toBe("schema");
  expect(bad({ version: 1, collections: [collection("spaces", { x: z.string() })] })).toBe("schema");
  expect(bad({ version: 1, collections: [collection("transact", { x: z.string() })] })).toBe("schema");
  expect(bad({ version: 1, collections: [{ name: "a", shape: { x: z.string() }, indexes: { i: ["nope"] } }] })).toBe("schema");
  expect(bad({ version: 1, collections: [{ name: "a", shape: { b: richText() }, indexes: { i: ["b"] } }] })).toBe("schema");
  expect(bad({ version: 1, collections: [{ name: "a", shape: { id: z.string() }, indexes: {} }] })).toBe("schema");
  expect(bad({ version: 0, collections: [List] })).toBe("schema");
  expect(bad({ version: 1, collections: [List, Todo, Item] })).toBe("ok");
  expect(bad({ version: 1, collections: [collection("n", { f: file().optional() })] })).toBe("ok");
});

test("field validators: ref and file check shape, and an async validator is a failure", async () => {
  const tab = await openTab(uniqueName());
  const todos = coll(tab, "todos");
  const space = randomSpace();
  const list = todos.fields.get("list")!;
  expect(list.validate(toBase64url(newId(space))).ok).toBe(true);
  expect(list.validate("nope").ok).toBe(false);
  expect(list.validate(undefined).ok).toBe(false);
  expect(todos.fields.get("image")!.validate(undefined)).toEqual({ ok: true, value: undefined });
  expect(todos.fields.get("image")!.validate({ id: "x" }).ok).toBe(false);
  expect(todos.fields.get("done")!.fallback).toEqual({ kind: "default", value: false });
  expect(todos.fields.get("note")!.fallback).toEqual({ kind: "absent" });
  expect(todos.fields.get("title")!.fallback).toEqual({ kind: "required" });
  const asyncSchema = {
    "~standard": { version: 1 as const, vendor: "x", validate: async () => ({ value: "a" }) },
  };
  const A = collection("asyncs", { a: asyncSchema });
  const kv = await openHarnessDb({ name: uniqueName(), forceMemory: true });
  const store = await LocalStore.open(kv, defineSchema({ version: 1, collections: [A] }), new Clock(1));
  const field = store.catalog.collections.get("asyncs")!.fields.get("a")!;
  expect(field.validate("a").ok).toBe(false);
  expect(field.fallback).toEqual({ kind: "required" });
});
